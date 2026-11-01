#include "core/machine-config.h"
#include "core/paths.h"

#include <boost/hash2/sha2.hpp>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <fcntl.h>
#include <fstream>
#include <sstream>
#include <unistd.h>

namespace json = boost::json;

namespace varan {

	std::string write_durable(const std::filesystem::path& path, const std::string& data) {
		std::error_code ec;
		std::filesystem::create_directories(path.parent_path(), ec);
		const auto tmp = path.string() + ".tmp";

		const int fd = ::open(tmp.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
		if (fd < 0) return "cannot open " + tmp;
		std::size_t written = 0;
		while (written < data.size()) {
			const auto n = ::write(fd, data.data() + written, data.size() - written);
			if (n <= 0) {
				::close(fd);
				return "write failed for " + tmp;
			}
			written += static_cast<std::size_t>(n);
		}
		if (::fsync(fd) != 0) {
			::close(fd);
			return "fsync failed for " + tmp;
		}
		::close(fd);

		std::filesystem::rename(tmp, path, ec);
		if (ec) return "rename failed for " + path.string() + ": " + ec.message();

		const int dir = ::open(path.parent_path().c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
		if (dir >= 0) {
			::fsync(dir);
			::close(dir);
		}
		return {};
	}

	static std::string sha256_hex(const std::string& data) {
		boost::hash2::sha2_256 hash;
		hash.update(data.data(), data.size());
		return boost::hash2::to_string(hash.result());
	}

	std::string sha256_file(const std::filesystem::path& path) {
		std::ifstream file(path, std::ios::binary);
		if (!file) return {};
		boost::hash2::sha2_256 hash;
		std::vector<char> buffer(1 << 20);
		while (file) {
			file.read(buffer.data(), static_cast<std::streamsize>(buffer.size()));
			if (file.gcount() > 0) hash.update(buffer.data(), static_cast<std::size_t>(file.gcount()));
		}
		return boost::hash2::to_string(hash.result());
	}

	std::string place_asset(const std::filesystem::path& dst, const std::string& sha256, bool& replaced) {
		replaced = false;
		if (sha256_file(dst) == sha256) return {};
		std::ifstream file(paths().config.assets / sha256, std::ios::binary);
		if (!file) return "file " + sha256 + " is not in the asset cache";
		std::stringstream ss;
		ss << file.rdbuf();
		if (auto error = write_durable(dst, ss.str()); !error.empty()) return error;
		replaced = true;
		return {};
	}

	static bool valid_sha(const std::string& sha) {
		return sha.size() == 64 && std::all_of(sha.begin(), sha.end(), [](unsigned char c) {
			return std::isdigit(c) || (c >= 'a' && c <= 'f');
		});
	}

	UMachineConfig::UMachineConfig(ULogger::ELoggerLevel level)
		: m_logger("Machine Config", level)
	{
		m_hold = {{"transition_id", ""}, {"held", false}, {"modules", json::array{}}};
		const auto hold_path = paths().config.applied.parent_path() / "hold.json";
		if (std::filesystem::exists(hold_path)) {
			try {
				std::ifstream input(hold_path);
				m_hold = json::parse(std::string((std::istreambuf_iterator<char>(input)), {})).as_object();
				if (!m_hold.at("held").is_bool() || !m_hold.at("modules").is_array()
					|| !m_hold.at("transition_id").is_string() || m_hold.at("transition_id").as_string().empty())
					throw std::runtime_error("invalid configuration hold");
			}
			catch (const std::exception& error) {
				m_logger.error("cannot read configuration hold: " + std::string(error.what()));
				m_hold = {{"transition_id", ""}, {"held", true}, {"modules", json::array{}}};
			}
		}
		std::ifstream file(paths().config.applied);
		if (!file) return;
		std::stringstream ss;
		ss << file.rdbuf();
		boost::system::error_code ec;
		auto value = json::parse(ss.str(), ec);
		if (!ec && value.is_object()) {
			m_applied = value.as_object();
			m_logger.info("applied revision " + revision());
		}
		else {
			m_logger.error("cannot parse " + paths().config.applied.string() + ", starting without revision");
		}
	}

	void UMachineConfig::register_part(const std::string& name, CConfigPartApplier applier) {
		std::lock_guard lock(m_mutex);
		m_parts.emplace_back(name, std::move(applier));
	}

	std::string UMachineConfig::revision() const {
		std::lock_guard lock(m_mutex);
		if (auto* v = m_applied.if_contains("revision"); v && v->is_string()) {
			return std::string(v->as_string());
		}
		return {};
	}

	json::object UMachineConfig::applied() const {
		std::lock_guard lock(m_mutex);
		return m_applied;
	}

	json::object UMachineConfig::hold_status() const {
		std::lock_guard lock(m_mutex);
		auto result = m_hold;
		result["revision"] = m_applied.if_contains("revision") ? m_applied.at("revision") : json::value("");
		json::array available;
		for (const auto& [name, _] : m_parts) available.push_back(json::value(name));
		result["available"] = std::move(available);
		return result;
	}

	std::string UMachineConfig::set_hold(const json::object& command) {
		std::lock_guard lock(m_mutex);
		const auto* token = command.if_contains("transition_id");
		const auto* held = command.if_contains("held");
		if (!token || !token->is_string() || token->as_string().empty() || token->as_string().size() > 128
			|| !std::all_of(token->as_string().begin(), token->as_string().end(), [](unsigned char c) {
				return std::isalnum(c) || c == '_' || c == '-';
			})) return "invalid transition id";
		if (!held || !held->is_bool()) return "held must be a boolean";
		if (held->as_bool()) {
			if (*token == m_hold.at("transition_id") && !m_hold.at("held").as_bool()) return "transition has already started";
			if (*token != m_hold.at("transition_id") && (!command.if_contains("previous_transition_id")
				|| command.at("previous_transition_id") != m_hold.at("transition_id"))) return "obsolete configuration hold";
			m_hold["held"] = true;
			m_hold["transition_id"] = *token;
			return write_durable(paths().config.applied.parent_path() / "hold.json", json::serialize(m_hold));
		}
		if (*token != m_hold.at("transition_id")) return "release belongs to another transition";
		if (!command.if_contains("revision") || !m_applied.if_contains("revision")
			|| command.at("revision") != m_applied.at("revision")) return "release revision does not match applied configuration";
		const auto* modules = command.if_contains("modules");
		if (!modules || !modules->is_array()) return "modules must be an array";
		for (const auto& module : modules->as_array())
			if (!module.is_string() || std::none_of(m_parts.begin(), m_parts.end(), [&](const auto& part) {
				return module.as_string() == part.first;
			})) return "unknown configuration part";
		if (!m_hold.at("held").as_bool() && *modules != m_hold.at("modules")) return "transition has already started";
		auto released = m_hold;
		released["held"] = false;
		released["modules"] = *modules;
		if (auto error = write_durable(paths().config.applied.parent_path() / "hold.json", json::serialize(released)); !error.empty()) return error;
		m_hold = std::move(released);
		return {};
	}

	std::string UMachineConfig::check_command(const json::object& command, bool starting) const {
		std::lock_guard lock(m_mutex);
		const auto* token = command.if_contains("transition_id");
		if (!token && !m_hold.at("held").as_bool()) return {};
		if (!token || !token->is_string() || token->as_string().empty()
			|| *token != m_hold.at("transition_id") || !m_hold.at("held").as_bool())
			return "module command belongs to another transition";
		if (starting && (!command.if_contains("revision") || !m_applied.if_contains("revision")
			|| command.at("revision") != m_applied.at("revision"))) return "start revision does not match applied configuration";
		return {};
	}

	bool UMachineConfig::allows_start(const std::string& part) const {
		std::lock_guard lock(m_mutex);
		if (m_hold.at("held").as_bool()) return false;
		const auto& modules = m_hold.at("modules").as_array();
		return m_hold.at("transition_id").as_string().empty()
			|| std::any_of(modules.begin(), modules.end(), [&](const auto& module) { return module.is_string() && module.as_string() == part; });
	}

	std::filesystem::path UMachineConfig::asset_path(const std::string& sha256) const {
		return paths().config.assets / sha256;
	}

	bool UMachineConfig::has_asset(const std::string& sha256) const {
		std::error_code ec;
		return valid_sha(sha256) && std::filesystem::is_regular_file(asset_path(sha256), ec);
	}

	std::string UMachineConfig::put_asset(const std::string& sha256, const std::string& body) {
		if (!valid_sha(sha256)) return "sha256 must be 64 lowercase hex digits";
		if (sha256_hex(body) != sha256) return "body does not match sha256";
		if (has_asset(sha256)) return {};
		auto error = write_durable(asset_path(sha256), body);
		if (error.empty()) m_logger.info("asset " + sha256 + " stored, " + std::to_string(body.size()) + " bytes");
		return error;
	}

	FConfigApplyResult UMachineConfig::apply(const json::object& package) {
		FConfigApplyResult result;
		{
			std::lock_guard lock(m_mutex);
			const auto* token = package.if_contains("transition_id");
			if ((token && (*token != m_hold.at("transition_id") || !token->is_string()
				|| (m_hold.at("held").as_bool() && token->as_string().empty())))
				|| (!token && (m_hold.at("held").as_bool() || !m_hold.at("transition_id").as_string().empty()))) {
				result.error = "configuration belongs to another transition";
				return result;
			}
		}
		const auto* revision = package.if_contains("revision");
		if (!revision || !revision->is_string() || revision->as_string().empty()) {
			result.error = "package has no revision";
			return result;
		}

		if (const auto* assets = package.if_contains("assets"); assets && assets->is_array()) {
			for (const auto& sha : assets->as_array()) {
				if (!sha.is_string() || !has_asset(std::string(sha.as_string()))) {
					result.missing_assets.push_back(sha.is_string() ? std::string(sha.as_string()) : "");
				}
			}
		}
		if (!result.missing_assets.empty()) {
			result.error = "missing assets";
			return result;
		}

		json::object parts;
		if (const auto* p = package.if_contains("parts"); p && p->is_object()) {
			parts = p->as_object();
		}
		std::vector<std::pair<std::string, CConfigPartApplier>> handlers;
		json::object previous;
		{
			std::lock_guard lock(m_mutex);
			handlers = m_parts;
			if (const auto* p = m_applied.if_contains("parts"); p && p->is_object()) previous = p->as_object();
		}
		for (const auto& [name, _] : parts) {
			const bool known = std::any_of(handlers.begin(), handlers.end(),
				[&](const auto& h) { return h.first == name; });
			if (!known) {
				result.error = "part <" + std::string(name) + "> is not supported by this media-center";
				return result;
			}
		}
		for (const auto& [name, applier] : handlers) {
			const auto* part = parts.if_contains(name);
			if (!part) continue;
			// Часть, совпадающая с применённой, не трогается
			if (const auto* before = previous.if_contains(name); before && *before == *part) continue;
			auto error = applier(*part);
			if (!error.empty()) {
				result.error = "part <" + name + ">: " + error;
				m_logger.error("revision " + std::string(revision->as_string()) + ": " + result.error);
				return result;
			}
		}

		json::object applied;
		applied["revision"] = revision->as_string();
		applied["parts"] = parts;
		applied["applied_at"] = std::chrono::duration_cast<std::chrono::milliseconds>(
			std::chrono::system_clock::now().time_since_epoch()).count();
		if (auto error = write_durable(paths().config.applied, json::serialize(applied)); !error.empty()) {
			result.error = error;
			return result;
		}
		{
			std::lock_guard lock(m_mutex);
			m_applied = std::move(applied);
		}
		m_logger.info("applied revision " + std::string(revision->as_string()));
		result.ok = true;
		return result;
	}

} // varan
