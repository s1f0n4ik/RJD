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
