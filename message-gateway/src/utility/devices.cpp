#include "gateway/devices.h"
#include "gateway/log.h"

#include <algorithm>
#include <string>
#include <vector>

#if defined(__linux__)
#include <ifaddrs.h>
#include <net/if.h>
#include <dirent.h>
#include <cstring>
#endif

namespace varan {
    namespace gateway {

        namespace json = boost::json;

        namespace {

#if defined(__linux__)

            bool starts_with(const std::string& s, const char* p) {
                return s.rfind(p, 0) == 0;
            }

            // Интерфейсы CAN: can0, vcan0, slcan0. Отбираем по имени — тип линка
            // через getifaddrs не виден, а тащить netlink ради этого не стоит.
            bool is_can_name(const std::string& n) {
                return starts_with(n, "can") || starts_with(n, "vcan") || starts_with(n, "slcan");
            }

            json::array scan_can() {
                json::array out;
                ifaddrs* ifa = nullptr;
                if (::getifaddrs(&ifa) != 0) {
                    return out;
                }

                std::vector<std::string> seen;
                for (ifaddrs* p = ifa; p; p = p->ifa_next) {
                    if (!p->ifa_name) {
                        continue;
                    }
                    const std::string name = p->ifa_name;
                    if (!is_can_name(name)) {
                        continue;
                    }
                    // getifaddrs отдаёт интерфейс по записи на каждое семейство
                    // адресов — без этого can0 попал бы в список дважды.
                    if (std::find(seen.begin(), seen.end(), name) != seen.end()) {
                        continue;
                    }
                    seen.push_back(name);

                    json::object o;
                    o["name"] = name;
                    o["up"] = (p->ifa_flags & IFF_UP) != 0;
                    o["kind"] = starts_with(name, "vcan") ? "vcan" : "can";
                    out.push_back(std::move(o));
                }
                ::freeifaddrs(ifa);
                return out;
            }

            // Serial-порты: ttyUSB* и ttyACM* — под ними приходят USB-адаптеры
            // CAN. Голые ttyS* не показываем: их на машине десятки и почти все
            // мертвы, список станет нечитаемым.
            json::array scan_serial() {
                json::array out;
                DIR* d = ::opendir("/dev");
                if (!d) {
                    return out;
                }
                std::vector<std::string> names;
                while (dirent* e = ::readdir(d)) {
                    const std::string n = e->d_name;
                    if (starts_with(n, "ttyUSB") || starts_with(n, "ttyACM")) {
                        names.push_back(n);
                    }
                }
                ::closedir(d);

                std::sort(names.begin(), names.end());
                for (const auto& n : names) {
                    out.push_back(json::object{ {"name", "/dev/" + n} });
                }
                return out;
            }

#else

            // Перечисление устройств завязано на Linux. На других платформах
            // сервис собирается для разработки, списки просто пустые.
            json::array scan_can() { return {}; }
            json::array scan_serial() { return {}; }

#endif

        } // namespace

        boost::json::object list_devices() {
            json::object o;
            o["can"] = scan_can();
            o["serial"] = scan_serial();
            return o;
        }

    } // namespace gateway
} // namespace varan
