#pragma once

#include <vector>
#include <optional>

#include "utility/json-reader.h"
#include "neural/utility.h"

namespace varan {
namespace neural {

	/*
		Конфигурация нейросети.

		{
			"<config_id>": {
				"name": "Имя",
				"model_width": 1024,
				"model_height": 1024,
				"fps": camera_1,
				"thresholds": { "nms": 0.45, "confidence": 0.5 },
				"model_path": "path/to/model.rknn",
				"classes": {
					"<class_id>": { "name", "server_id", "superclass", "color" }
				},
				"superclasses": {
					"<superclass_id>": { "name", "color" }
				}
			}
		}
	*/
	class UJsonNeuralConfiguration : public UJsonReaderBase {
	public:
		explicit UJsonNeuralConfiguration(ULogger* logger = nullptr): UJsonReaderBase(logger) {}

		// Список доступных конфигураций (id + name).
		boost::json::array list_configs() const {
			boost::json::array result;
			for (const auto& [key, val] : m_json) {
				if (!val.is_object()) continue;
				boost::json::object item;
				item["config_id"] = key;
				if (auto* n = val.as_object().if_contains("name"); n && n->is_string()) {
					item["name"] = *n;
				}
				result.push_back(std::move(item));
			}
			return result;
		}

		std::optional<FConfigInfo> load_config(const std::string& config_id) const {
			try {
				auto it = m_json.find(config_id);
				if (it == m_json.end() || !it->value().is_object()) {
					log_error("load_config(): <" + config_id + "> not found");
					return std::nullopt;
				}
				const auto& obj = it->value().as_object();

				FConfigInfo info;
				info.id = config_id;
				if (auto* v = obj.if_contains("name"); v && v->is_string())
					info.name = v->as_string().c_str();
				if (auto* v = obj.if_contains("model_path"); v && v->is_string())
					info.model_path = v->as_string().c_str();
				if (auto* v = obj.if_contains("model_width"); v && v->is_int64())
					info.model_width = static_cast<int>(v->as_int64());
				if (auto* v = obj.if_contains("model_height"); v && v->is_int64())
					info.model_height = static_cast<int>(v->as_int64());
				if (auto* v = obj.if_contains("fps"); v && v->is_int64())
					info.fps = static_cast<int>(v->as_int64());

				if (auto* t = obj.if_contains("thresholds"); t && t->is_object()) {
					const auto& to = t->as_object();
					if (auto* v = to.if_contains("nms"); v && v->is_number())
						info.thresholds.nms = static_cast<float>(v->to_number<double>());
					if (auto* v = to.if_contains("confidence"); v && v->is_number())
						info.thresholds.confidence = static_cast<float>(v->to_number<double>());
				}

				if (auto* sc = obj.if_contains("superclasses"); sc && sc->is_object()) {
					for (const auto& [key_str, sv] : sc->as_object()) {
						if (!sv.is_object()) continue;
						FSuperclass s;
						s.key = key_str;
						const auto& so = sv.as_object();
						if (auto* v = so.if_contains("name"); v && v->is_string())
							s.name = v->as_string().c_str();
						if (auto* v = so.if_contains("color"); v && v->is_string())
							s.color = v->as_string().c_str();
						info.superclasses.push_back(std::move(s));
					}
				}

				if (auto* cls = obj.if_contains("classes"); cls && cls->is_object()) {
					for (const auto& [key_str, cv] : cls->as_object()) {
						if (!cv.is_object()) continue;
						FClassInfo c;
						try { c.id = std::stoi(std::string(key_str)); }
						catch (...) { continue; }
						const auto& co = cv.as_object();
						if (auto* v = co.if_contains("name"); v && v->is_string())       c.name = v->as_string().c_str();
						if (auto* v = co.if_contains("server_id"); v && v->is_string()) c.server_id = v->as_string().c_str();
						if (auto* v = co.if_contains("superclass"); v && v->is_string()) c.superclass = v->as_string().c_str();
						if (auto* v = co.if_contains("color"); v && v->is_string())     c.color = v->as_string().c_str();
						info.classes.push_back(std::move(c));
					}
					std::sort(info.classes.begin(), info.classes.end(),
						[](const auto& a, const auto& b) { return a.id < b.id; });
				}
				return info;
			}
			catch (const std::exception& e) {
				log_error("load_config(): " + std::string(e.what()));
				return std::nullopt;
			}
		}

	protected:
		std::string class_tag() const override { return "UJsonNeuralConfiguration "; }

		const std::unordered_set<std::string>& allowed_fields() const override {
			static const std::unordered_set<std::string> fields = {
				"name", "model_path", "model_width", "model_height", 
				"fps", "thresholds", "classes", "superclasses"
			};
			return fields;
		}
	};

} // namespace neural
} // namespace varan