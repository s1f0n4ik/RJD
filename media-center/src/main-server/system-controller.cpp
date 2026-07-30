#include "main-server/system-controller.h"
#include "main-server/helpers.h"
#include "core/paths.h"
#include "version.h"

#include <filesystem>
#include <fstream>
#include <sstream>
#include <thread>

#include <sys/statvfs.h>
#include <unistd.h>

namespace http = boost::beast::http;
namespace json = boost::json;
using namespace varan::rest;

static std::string read_first_line(const std::filesystem::path& path) {
    std::ifstream file(path);
    std::string line;
    if (file && std::getline(file, line)) {
        while (!line.empty() && (line.back() == '\n' || line.back() == '\r' || line.back() == ' ')) {
            line.pop_back();
        }
    }
    return line;
}

USystemController::USystemController(
    const varan::FModuleSet& modules,
    const varan::FPlatformInfo& platform,
    ULogger* logger
)
    : m_modules(modules)
    , m_platform(platform)
    , m_logger(logger)
{
    m_device_id = read_first_line("/etc/machine-id");
    if (m_device_id.empty()) {
        m_device_id = read_first_line("/var/lib/dbus/machine-id");
    }
    if (m_device_id.empty()) {
        m_device_id = "unknown";
        if (m_logger) m_logger->warn("USystemController: machine-id is not available");
    }
}

static json::object collect_disk(const std::string& label, const std::filesystem::path& path) {
    json::object disk;
    disk["label"] = label;
    disk["path"] = path.string();

    struct statvfs stat {};
    if (statvfs(path.c_str(), &stat) != 0) {
        disk["available"] = false;
        return disk;
    }

    const uint64_t block = stat.f_frsize;
    disk["available"] = true;
    disk["total_bytes"] = static_cast<uint64_t>(stat.f_blocks) * block;
    // f_bavail — доступно без root-резерва, именно это видит записывающий
    disk["free_bytes"] = static_cast<uint64_t>(stat.f_bavail) * block;
    return disk;
}

static json::array collect_temperature() {
    json::array zones;
    std::error_code ec;
    for (const auto& entry : std::filesystem::directory_iterator("/sys/class/thermal", ec)) {
        const std::string name = entry.path().filename().string();
        if (name.rfind("thermal_zone", 0) != 0) continue;

        const std::string raw = read_first_line(entry.path() / "temp");
        if (raw.empty()) continue;

        json::object zone;
        zone["zone"] = read_first_line(entry.path() / "type");
        zone["celsius"] = std::strtol(raw.c_str(), nullptr, 10) / 1000.0;
        zones.push_back(std::move(zone));
    }
    return zones;
}

static json::array collect_network() {
    json::array interfaces;
    std::ifstream file("/proc/net/dev");
    std::string line;
    // Первые две строки — заголовок таблицы
    std::getline(file, line);
    std::getline(file, line);

    while (std::getline(file, line)) {
        std::istringstream ss(line);
        std::string iface;
        ss >> iface;
        if (iface.empty() || iface.back() != ':') continue;
        iface.pop_back();
        if (iface == "lo") continue;

        // rx: bytes packets errs drop fifo frame compressed multicast, потом tx
        uint64_t rx_bytes = 0, tx_bytes = 0, skip = 0;
        ss >> rx_bytes;
        for (int i = 0; i < 7; ++i) ss >> skip;
        ss >> tx_bytes;

        json::object item;
        item["iface"] = iface;
        item["rx_bytes"] = rx_bytes;
        item["tx_bytes"] = tx_bytes;
        interfaces.push_back(std::move(item));
    }
    return interfaces;
}

json::object USystemController::collect() {
    json::object info;

    info["device_id"] = m_device_id;

    char hostname[256] = {};
    gethostname(hostname, sizeof(hostname) - 1);
    info["hostname"] = hostname;

    info["version"] = std::string(varan::version::string);

    json::array modules;
    for (const auto& name : m_modules.names()) {
        modules.push_back(json::value(name));
    }
    info["modules"] = std::move(modules);

    json::object platform;
    platform["platform"] = m_platform.platform;
    platform["label"] = m_platform.label;
    platform["mode"] = m_platform.mode;
    platform["npu_cores"] = m_platform.npu_cores;
    platform["max_streams"] = m_platform.max_streams;
    info["platform"] = std::move(platform);

    {
        std::istringstream ss(read_first_line("/proc/uptime"));
        double uptime = 0.0;
        ss >> uptime;
        info["uptime_sec"] = uptime;
    }

    {
        json::object cpu;
        cpu["cores"] = static_cast<int64_t>(std::thread::hardware_concurrency());
        std::istringstream ss(read_first_line("/proc/loadavg"));
        double load_1 = 0.0, load_5 = 0.0, load_15 = 0.0;
        ss >> load_1 >> load_5 >> load_15;
        cpu["load_1"] = load_1;
        cpu["load_5"] = load_5;
        cpu["load_15"] = load_15;

        // Проценты по дельте /proc/stat; первый вызов после старта отдаёт 0
        std::istringstream stat(read_first_line("/proc/stat"));
        std::string label;
        uint64_t value = 0, total = 0, idle = 0;
        int field = 0;
        stat >> label;
        while (stat >> value) {
            total += value;
            // idle + iowait — 4-е и 5-е поля
            if (field == 3 || field == 4) idle += value;
            ++field;
        }

        double percent = 0.0;
        if (m_prev_cpu_total > 0 && total > m_prev_cpu_total) {
            const auto d_total = total - m_prev_cpu_total;
            const auto d_idle = idle - m_prev_cpu_idle;
            percent = 100.0 * (1.0 - static_cast<double>(d_idle) / static_cast<double>(d_total));
        }
        m_prev_cpu_total = total;
        m_prev_cpu_idle = idle;
        cpu["percent"] = percent;

        info["cpu"] = std::move(cpu);
    }

    {
        json::object memory;
        std::ifstream file("/proc/meminfo");
        std::string key;
        uint64_t value = 0;
        std::string unit;
        while (file >> key >> value >> unit) {
            if (key == "MemTotal:") memory["total_bytes"] = value * 1024;
            else if (key == "MemAvailable:") memory["available_bytes"] = value * 1024;
        }
        info["memory"] = std::move(memory);
    }

    info["temperature"] = collect_temperature();

    // Счётчики накопительные: скорость считает опрашивающая сторона по дельтам
    info["network"] = collect_network();

    {
        json::array disks;
        const auto varan_root = varan::paths().nvr.config.parent_path().parent_path();
        disks.push_back(collect_disk("varan_root", varan_root));
        disks.push_back(collect_disk("storage", varan::paths().journal));
        info["disks"] = std::move(disks);
    }

    return info;
}

http::response<http::string_body>
USystemController::get_info(const http::request<http::string_body>& req)
{
    const std::string tag = "GET /system/info";

    try {
        json::object body;
        body["data"] = collect();
        // Телеметрию опрашивают раз в секунды, полный дамп ответа зашумит лог
        return make_response(req.version(), http::status::ok, body);
    }
    catch (const std::exception& e) {
        return json_error(m_logger, req, http::status::internal_server_error, e.what(), tag);
    }
}
