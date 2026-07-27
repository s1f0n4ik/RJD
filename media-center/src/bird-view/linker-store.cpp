#include "bird-view/linker-store.h"

#include <fstream>
#include <sstream>

namespace varan {
namespace birdview {

	ULinkerStore::ULinkerStore(
		std::filesystem::path exports_root,
		std::filesystem::path exports_index,
		std::filesystem::path state_root,
		std::filesystem::path state_index,
		ULogger* logger)
		: m_exports_root(std::move(exports_root))
		, m_exports_index(std::move(exports_index))
		, m_state_root(std::move(state_root))
		, m_state_index(std::move(state_index))
		, m_logger(logger)
	{
	}

	boost::json::object ULinkerStore::read_json_object(const std::filesystem::path& path) const {
		try {
			std::ifstream f(path);
			if (!f) return {};
			std::stringstream ss;
			ss << f.rdbuf();
			auto v = boost::json::parse(ss.str());
			if (v.is_object()) return v.as_object();
		}
		catch (const std::exception& e) {
			if (m_logger) m_logger->error("read_json_object(): " + path.string()
				+ ": " + std::string(e.what()));
		}
		return {};
	}

	bool ULinkerStore::write_json_object(const std::filesystem::path& path,
		const boost::json::object& root, std::string& error)
	{
		try {
			const auto parent = path.parent_path();
			if (!parent.empty()) std::filesystem::create_directories(parent);
			std::ofstream f(path);
			if (!f) {
				error = "cannot open " + path.string() + " for writing";
				return false;
			}
			f << boost::json::serialize(root);
			return true;
		}
		catch (const std::exception& e) {
			error = e.what();
			return false;
		}
	}

	boost::json::object ULinkerStore::read_state_unlocked() const {
		boost::json::object empty;
		empty["active"] = "";
		empty["configs"] = boost::json::object();

		auto root = read_json_object(state_path());
		if (root.empty()) return empty;

		// Уже новый формат
		if (auto* configs = root.if_contains("configs"); configs && configs->is_object()) {
			if (!root.contains("active")) root["active"] = "";
			return root;
		}

		// Старый формат: одна активная запись
		const std::string old_id = js::str(root, "export_id");
		if (old_id.empty()) return empty;

		boost::json::object entry;
		if (auto* cams = js::obj(root, "cameras")) entry["cameras"] = *cams;
		else entry["cameras"] = boost::json::object();

		boost::json::object configs;
		configs[old_id] = std::move(entry);

		boost::json::object migrated;
		migrated["active"] = old_id;
		migrated["configs"] = std::move(configs);
		return migrated;
	}

	boost::json::object ULinkerStore::read_state() const {
		std::lock_guard<std::mutex> lk(m_state_mutex);
		return read_state_unlocked();
	}

	bool ULinkerStore::mutate_state_entry(const std::string& export_id,
		const std::function<void(boost::json::object&)>& mutate,
		bool set_active, std::string& error)
	{
		std::lock_guard<std::mutex> lk(m_state_mutex);
		try {
			auto root = read_state_unlocked();
			auto configs = root.at("configs").as_object();

			// Запись правится, а не собирается заново: собранная с нуля
			// потеряла бы всё, чего не передали в этом вызове
			boost::json::object entry;
			if (auto* prev = configs.if_contains(export_id); prev && prev->is_object()) {
				entry = prev->as_object();
			}
			mutate(entry);
			configs[export_id] = std::move(entry);

			root["configs"] = std::move(configs);
			if (set_active) root["active"] = export_id;

			return write_json_object(state_path(), root, error);
		}
		catch (const std::exception& e) {
			error = e.what();
			return false;
		}
	}

	bool ULinkerStore::erase_state_entry(const std::string& export_id, std::string& error) {
		std::lock_guard<std::mutex> lk(m_state_mutex);
		try {
			auto root = read_state_unlocked();
			auto configs = root.at("configs").as_object();
			configs.erase(export_id);

			if (js::str(root, "active") == export_id) root["active"] = "";
			root["configs"] = std::move(configs);

			return write_json_object(state_path(), root, error);
		}
		catch (const std::exception& e) {
			error = e.what();
			return false;
		}
	}

	boost::json::object ULinkerStore::read_exports_root() const {
		std::lock_guard<std::mutex> lk(m_exports_mutex);
		return read_json_object(exports_index_path());
	}

	std::optional<boost::json::object> ULinkerStore::read_export_entry(
		const std::string& export_id) const
	{
		std::lock_guard<std::mutex> lk(m_exports_mutex);
		auto root = read_json_object(exports_index_path());
		if (auto* e = root.if_contains(export_id); e && e->is_object()) {
			return e->as_object();
		}
		return std::nullopt;
	}

	std::optional<boost::json::object> ULinkerStore::read_surround_cfg(
		const std::string& export_id) const
	{
		if (auto entry = read_export_entry(export_id)) {
			if (auto* s = js::obj(*entry, "surround")) return *s;
		}
		return std::nullopt;
	}

	std::optional<boost::json::object> ULinkerStore::read_top_cfg(
		const std::string& export_id) const
	{
		if (auto entry = read_export_entry(export_id)) {
			if (auto* t = js::obj(*entry, "top")) return *t;
		}
		return std::nullopt;
	}

	bool ULinkerStore::mutate_top_block(const std::string& export_id,
		const std::function<bool(boost::json::object&, std::string&)>& mutate,
		std::string& error)
	{
		std::lock_guard<std::mutex> lk(m_exports_mutex);
		try {
			auto root = read_json_object(exports_index_path());
			if (root.empty()) {
				error = "cannot read exports index";
				return false;
			}

			auto* entry = root.if_contains(export_id);
			if (!entry || !entry->is_object()) {
				error = "export <" + export_id + "> not found";
				return false;
			}
			auto& entry_obj = entry->as_object();

			// Блок заводится на месте: у экспортов до этой фичи его нет
			boost::json::object top;
			if (auto* t = js::obj(entry_obj, "top")) top = *t;
			if (!mutate(top, error)) return false;
			entry_obj["top"] = std::move(top);

			return write_json_object(exports_index_path(), root, error);
		}
		catch (const std::exception& e) {
			error = e.what();
			return false;
		}
	}

	bool ULinkerStore::mutate_export_entry(const std::string& export_id,
		const std::function<bool(boost::json::object&, std::string&)>& mutate,
		std::string& error)
	{
		std::lock_guard<std::mutex> lk(m_exports_mutex);
		try {
			auto root = read_json_object(exports_index_path());
			if (root.empty()) {
				error = "cannot read exports index";
				return false;
			}

			auto* entry = root.if_contains(export_id);
			if (!entry || !entry->is_object()) {
				error = "export <" + export_id + "> not found";
				return false;
			}

			if (!mutate(entry->as_object(), error)) return false;

			return write_json_object(exports_index_path(), root, error);
		}
		catch (const std::exception& e) {
			error = e.what();
			return false;
		}
	}

	bool ULinkerStore::mutate_surround_block(const std::string& export_id,
		const std::function<bool(boost::json::object&, std::string&)>& mutate,
		std::string& error)
	{
		std::lock_guard<std::mutex> lk(m_exports_mutex);
		try {
			auto root = read_json_object(exports_index_path());
			if (root.empty()) {
				error = "cannot read exports index";
				return false;
			}

			auto* entry = root.if_contains(export_id);
			if (!entry || !entry->is_object()) {
				error = "export <" + export_id + "> not found";
				return false;
			}
			auto& entry_obj = entry->as_object();

			auto* surround = entry_obj.if_contains("surround");
			if (!surround || !surround->is_object()) {
				error = "export <" + export_id + "> has no surround block";
				return false;
			}

			if (!mutate(surround->as_object(), error)) return false;

			return write_json_object(exports_index_path(), root, error);
		}
		catch (const std::exception& e) {
			error = e.what();
			return false;
		}
	}

	bool ULinkerStore::erase_export_entry(const std::string& export_id, std::string& error) {
		std::lock_guard<std::mutex> lk(m_exports_mutex);
		try {
			if (!std::filesystem::exists(exports_index_path())) {
				error = "exports index not found";
				return false;
			}
			auto root = read_json_object(exports_index_path());
			if (!root.contains(export_id)) {
				error = "export <" + export_id + "> not found";
				return false;
			}
			root.erase(export_id);
			return write_json_object(exports_index_path(), root, error);
		}
		catch (const std::exception& e) {
			error = e.what();
			return false;
		}
	}

} // birdview
} // varan
