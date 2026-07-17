#include "gateway/taxonomy.h"
#include "gateway/log.h"

#include <algorithm>
#include <cctype>

namespace varan {
    namespace gateway {

        namespace json = boost::json;

        namespace {

            const char* TAG = "taxonomy";

            // Словарь типов обнаружения из протокола. Фиксирован: числа задаёт
            // сторона заказчика, менять их через настройки нельзя.
            const char* TYPE_TITLES[] = {
                "",
                "Человек",
                "Инструмент",
                "Металлический предмет",
                "Каменные и бетонные материалы",
                "Древесные материалы",
                "Полимерные и текстильные материалы",
                "Сезонные и погодные объекты",
                "Специфические предметы, связанные с работами РСМ"
            };

            // Словарь классов опасности из протокола, тоже фиксирован.
            const char* DANGER_TITLES[] = {
                "",
                "Информация (нет опасности)",
                "Средняя опасность",
                "Высокая опасность",
                "Критическая опасность"
            };

            std::string lower(std::string s) {
                std::transform(s.begin(), s.end(), s.begin(),
                    [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
                return s;
            }

            bool valid_type(int t) {
                return t >= 1 && t <= 8;
            }

            bool valid_danger(int d) {
                return d >= 1 && d <= 4;
            }

            json::object rule_json(const UTaxonomy::FRule& r) {
                json::object o;
                o["key"] = r.key;
                o["title"] = r.title;
                o["type"] = r.type;
                o["danger"] = r.danger;
                return o;
            }

        } // namespace

        // Значения по умолчанию покрывают суперклассы, которые сейчас отдаёт конфиг
        // модели (human/animal), и восемь канонических групп протокола. Реальные
        // имена классов зависят от модели, поэтому список классов пуст: он
        // заполняется на странице под конкретную модель.
        UTaxonomy::UTaxonomy() {
            m_superclasses = {
                { "human",     "Человек",                            1, 4 },
                { "person",    "Человек",                            1, 4 },
                { "animal",    "Животное",                           8, 3 },
                { "tool",      "Инструмент",                         2, 2 },
                { "metal",     "Металлический предмет",              3, 3 },
                { "stone",     "Каменные и бетонные материалы",      4, 2 },
                { "wood",      "Древесные материалы",                5, 2 },
                { "polymer",   "Полимерные и текстильные материалы", 6, 2 },
                { "seasonal",  "Сезонные и погодные объекты",        7, 1 },
                { "rsm",       "Предметы работ РСМ",                 8, 1 },
            };

            m_cameras = {
                { "path", "Камера контроля опасности на пути", 1 },
                { "work", "Камера контроля рабочей зоны",      2 },
            };
        }

        const UTaxonomy::FRule* UTaxonomy::find(const std::vector<FRule>& rules, const std::string& key) {
            if (key.empty()) {
                return nullptr;
            }
            const std::string needle = lower(key);
            for (const auto& r : rules) {
                if (lower(r.key) == needle) {
                    return &r;
                }
            }
            return nullptr;
        }

        UTaxonomy::FResolved UTaxonomy::resolve(const FDetection& det) const {
            std::lock_guard<std::mutex> lock(m_mutex);

            FResolved out;

            // Класс перекрывает суперкласс, но только теми полями, которые в нём
            // заданы: правило класса может уточнять лишь опасность, оставляя тип
            // от группы.
            if (const FRule* c = find(m_classes, det.cls)) {
                if (valid_type(c->type))     out.type = c->type;
                if (valid_danger(c->danger)) out.danger = c->danger;
            }

            if (det.scls) {
                if (const FRule* s = find(m_superclasses, *det.scls)) {
                    if (out.type == 0 && valid_type(s->type))       out.type = s->type;
                    if (out.danger == 0 && valid_danger(s->danger)) out.danger = s->danger;
                }
            }

            if (out.type == 0)   out.type = m_default_type;
            if (out.danger == 0) out.danger = m_default_danger;

            out.type_title = type_title(out.type);
            out.danger_title = danger_title(out.danger);
            return out;
        }

        int UTaxonomy::resolve_camera(const std::string& camera_id) const {
            std::lock_guard<std::mutex> lock(m_mutex);
            if (camera_id.empty()) {
                return 0;
            }
            const std::string needle = lower(camera_id);
            for (const auto& c : m_cameras) {
                if (lower(c.key) == needle) {
                    return c.id;
                }
            }
            return 0;
        }

        std::string UTaxonomy::type_title(int type) {
            if (type >= 1 && type <= 8) {
                return TYPE_TITLES[type];
            }
            return "Неизвестный тип";
        }

        std::string UTaxonomy::danger_title(int danger) {
            if (danger >= 1 && danger <= 4) {
                return DANGER_TITLES[danger];
            }
            return "Неизвестный класс";
        }

        boost::json::object UTaxonomy::to_json() const {
            std::lock_guard<std::mutex> lock(m_mutex);

            // Словари протокола отдаём вместе с правилами, чтобы страница рисовала
            // читаемые названия и не держала их у себя копией.
            json::array types;
            for (int t = 1; t <= 8; ++t) {
                types.push_back(json::object{ {"id", t}, {"title", type_title(t)} });
            }
            json::array dangers;
            for (int d = 1; d <= 4; ++d) {
                dangers.push_back(json::object{ {"id", d}, {"title", danger_title(d)} });
            }

            json::array classes;
            for (const auto& r : m_classes) {
                classes.push_back(rule_json(r));
            }
            json::array superclasses;
            for (const auto& r : m_superclasses) {
                superclasses.push_back(rule_json(r));
            }
            json::array cameras;
            for (const auto& c : m_cameras) {
                cameras.push_back(json::object{ {"key", c.key}, {"title", c.title}, {"id", c.id} });
            }

            json::object defaults;
            defaults["type"] = m_default_type;
            defaults["danger"] = m_default_danger;

            json::object o;
            o["types"] = std::move(types);
            o["dangers"] = std::move(dangers);
            o["classes"] = std::move(classes);
            o["superclasses"] = std::move(superclasses);
            o["cameras"] = std::move(cameras);
            o["defaults"] = std::move(defaults);
            return o;
        }

        bool UTaxonomy::parse_rules(const json::value& v, std::vector<FRule>& out, std::string& err) {
            if (!v.is_array()) {
                err = "expected array of rules";
                return false;
            }
            std::vector<FRule> parsed;
            for (const auto& item : v.as_array()) {
                if (!item.is_object()) {
                    err = "rule must be an object";
                    return false;
                }
                const auto& o = item.as_object();

                FRule r;
                if (auto* k = o.if_contains("key"); k && k->is_string()) {
                    r.key = json::value_to<std::string>(*k);
                }
                if (r.key.empty()) {
                    err = "rule requires non-empty 'key'";
                    return false;
                }
                if (auto* t = o.if_contains("title"); t && t->is_string()) {
                    r.title = json::value_to<std::string>(*t);
                }

                try {
                    if (auto* t = o.if_contains("type"); t && !t->is_null()) {
                        r.type = t->to_number<int>();
                    }
                    if (auto* d = o.if_contains("danger"); d && !d->is_null()) {
                        r.danger = d->to_number<int>();
                    }
                }
                catch (const std::exception& e) {
                    err = std::string("rule '") + r.key + "': " + e.what();
                    return false;
                }

                // 0 — легальное "не задано", всё остальное вне диапазона протокола
                // молча пропускать нельзя: правило будет работать не так, как
                // выглядит на странице.
                if (r.type != 0 && !valid_type(r.type)) {
                    err = "rule '" + r.key + "': type must be 0 or 1..8";
                    return false;
                }
                if (r.danger != 0 && !valid_danger(r.danger)) {
                    err = "rule '" + r.key + "': danger must be 0 or 1..4";
                    return false;
                }
                parsed.push_back(std::move(r));
            }
            out = std::move(parsed);
            return true;
        }

        bool UTaxonomy::parse_cameras(const json::value& v, std::vector<FCamera>& out, std::string& err) {
            if (!v.is_array()) {
                err = "expected array of cameras";
                return false;
            }
            std::vector<FCamera> parsed;
            for (const auto& item : v.as_array()) {
                if (!item.is_object()) {
                    err = "camera must be an object";
                    return false;
                }
                const auto& o = item.as_object();

                FCamera c;
                if (auto* k = o.if_contains("key"); k && k->is_string()) {
                    c.key = json::value_to<std::string>(*k);
                }
                if (c.key.empty()) {
                    err = "camera requires non-empty 'key'";
                    return false;
                }
                if (auto* t = o.if_contains("title"); t && t->is_string()) {
                    c.title = json::value_to<std::string>(*t);
                }
                try {
                    if (auto* i = o.if_contains("id"); i && !i->is_null()) {
                        c.id = i->to_number<int>();
                    }
                }
                catch (const std::exception& e) {
                    err = std::string("camera '") + c.key + "': " + e.what();
                    return false;
                }
                if (c.id < 1 || c.id > 2) {
                    err = "camera '" + c.key + "': id must be 1 or 2";
                    return false;
                }
                parsed.push_back(std::move(c));
            }
            out = std::move(parsed);
            return true;
        }

        bool UTaxonomy::apply_json(const json::object& patch, std::string& err) {
            // Разбираем всё во временные значения и подменяем только после того,
            // как вся заплата признана валидной: иначе таблица останется наполовину
            // обновлённой и обнаружения поедут не в тот тип.
            std::vector<FRule> classes;
            std::vector<FRule> superclasses;
            std::vector<FCamera> cameras;
            bool has_classes = false, has_superclasses = false, has_cameras = false;

            if (auto* v = patch.if_contains("classes")) {
                if (!parse_rules(*v, classes, err)) return false;
                has_classes = true;
            }
            if (auto* v = patch.if_contains("superclasses")) {
                if (!parse_rules(*v, superclasses, err)) return false;
                has_superclasses = true;
            }
            if (auto* v = patch.if_contains("cameras")) {
                if (!parse_cameras(*v, cameras, err)) return false;
                has_cameras = true;
            }

            int def_type = 0, def_danger = 0;
            bool has_defaults = false;
            if (auto* v = patch.if_contains("defaults"); v && v->is_object()) {
                const auto& o = v->as_object();
                try {
                    if (auto* t = o.if_contains("type"))   def_type = t->to_number<int>();
                    if (auto* d = o.if_contains("danger")) def_danger = d->to_number<int>();
                }
                catch (const std::exception& e) {
                    err = std::string("defaults: ") + e.what();
                    return false;
                }
                if (def_type != 0 && !valid_type(def_type)) {
                    err = "defaults.type must be 1..8";
                    return false;
                }
                if (def_danger != 0 && !valid_danger(def_danger)) {
                    err = "defaults.danger must be 1..4";
                    return false;
                }
                has_defaults = true;
            }

            {
                std::lock_guard<std::mutex> lock(m_mutex);
                if (has_classes)      m_classes = std::move(classes);
                if (has_superclasses) m_superclasses = std::move(superclasses);
                if (has_cameras)      m_cameras = std::move(cameras);
                if (has_defaults) {
                    if (def_type != 0)   m_default_type = def_type;
                    if (def_danger != 0) m_default_danger = def_danger;
                }
            }

            ULog::info(TAG, "Updated");
            return true;
        }

    } // namespace gateway
} // namespace varan
