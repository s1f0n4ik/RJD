// fd_monitor.h
#pragma once
#include <string>
#include <vector>
#include <fstream>
#include <sstream>
#include <dirent.h>
#include <unistd.h>

struct FFdInfo {
    int fd;
    std::string link; // куда указывает дескриптор
};

class UFdMonitor {
public:
    // Получить все открытые fd текущего процесса
    static std::vector<FFdInfo> snapshot() {
        std::vector<FFdInfo> result;
        std::string fd_dir = "/proc/" + std::to_string(getpid()) + "/fd";

        DIR* dir = opendir(fd_dir.c_str());
        if (!dir) return result;

        struct dirent* entry;
        while ((entry = readdir(dir)) != nullptr) {
            if (entry->d_name[0] == '.') continue;

            int fd = std::stoi(entry->d_name);
            std::string path = fd_dir + "/" + entry->d_name;

            char buf[512] = {};
            ssize_t len = readlink(path.c_str(), buf, sizeof(buf) - 1);
            std::string link = (len > 0) ? std::string(buf, len) : "?";

            result.push_back({ fd, link });
        }

        closedir(dir);
        return result;
    }

    // Просто количество
    static int count() {
        return (int)snapshot().size();
    }

    // Лог с фильтром по подстроке (например "dma", "drm", "video")
    static std::string report(const std::string& filter = "") {
        auto fds = snapshot();
        std::ostringstream oss;
        oss << "=== FD Snapshot [pid=" << getpid() << "] total=" << fds.size() << " ===\n";
        for (auto& f : fds) {
            if (filter.empty() || f.link.find(filter) != std::string::npos) {
                oss << "  fd=" << f.fd << "  -> " << f.link << "\n";
            }
        }
        return oss.str();
    }
};