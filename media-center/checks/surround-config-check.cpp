#include <boost/json/src.hpp>

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <unistd.h>

#include "bird-view/linker-config.h"
#include "bird-view/top-bake.h"
#include "core/machine-config.h"
#include "core/paths.h"

namespace json = boost::json;
using namespace varan;
using namespace varan::birdview;

#define CHECK(condition) do { if (!(condition)) { std::fprintf(stderr, "FAIL %d: %s\n", __LINE__, #condition); std::exit(1); } } while (0)

namespace {

	json::object read(const std::filesystem::path& path) {
		std::ifstream file(path);
		std::string text((std::istreambuf_iterator<char>(file)), {});
		return json::parse(text).as_object();
	}

	void write(const std::filesystem::path& path, const json::object& value) {
		CHECK(write_durable(path, json::serialize(value)).empty());
	}

	json::object package() {
		return json::parse(R"({
			"calibrations": {}, "links": {},
			"presets": {"preset": {"name":"stand", "canvas":{"width":32,"height":32},
				"cameras":{"front":{"name":"front", "src_points":[[0,0],[1,0],[1,1],[0,1]],
					"dst_points":[[0,0],[32,0],[32,32],[0,32]]}}}},
			"projections": {"test":{"preset":"preset", "width":32,"height":32,
				"cameras":{"front":{"name":"front"}},
				"surround":{"preset":"preset", "orbit":{"speed":0.25},
					"extrinsics":{"front":{"position":[0,1,0],"yaw":0}}},
				"top":{"blend":0.3}}},
			"output":{"active":"test", "configs":{"test":{"cameras":{"front":"camera_1"},"fps":25}}}
		})").as_object();
	}

	json::object calibration(const std::string& camera, double focal) {
		const json::object matrix{ { "rows", 3 }, { "cols", 3 }, { "type", 6 },
			{ "data", json::array{ focal, 0, 16, 0, focal, 16, 0, 0, 1 } } };
		return { { "id", camera }, { "width", 32 }, { "height", 32 }, { "camera_matrix", matrix }, { "new_K", matrix },
			{ "distortion_coeffs", json::object{ { "rows", 4 }, { "cols", 1 }, { "type", 6 }, { "data", json::array{ 0, 0, 0, 0 } } } } };
	}

}

int main(int argc, char** argv) {
	char temporary[] = "/tmp/surround-config-check-XXXXXX";
	const char* root = mkdtemp(temporary);
	CHECK(root);
	init_paths(root, std::filesystem::path(root) / "archive");
	for (const auto& path : required_directories()) std::filesystem::create_directories(path);
	ULinkerStore store(paths().surround.projection_root, "projection.json", paths().surround.linker_state_root, "state.json", nullptr);
	int preparations = 0, applications = 0;
	std::string failure;
	FLinkerConfigUpdate last;
	ULinkerConfig config(store, nullptr,
		[&](const FLinkerConfigUpdate& update) { ++preparations; last = update; },
		[&](const FLinkerConfigUpdate& update) { ++applications; last = update; return failure; });
	UMachineConfig machine;
	machine.register_part("surround", [&](const json::value& body) { return config.apply(body, true); });
	auto apply = [&](const json::object& body, const std::string& revision) {
		return machine.apply(json::object{ { "revision", revision }, { "parts", json::object{ { "surround", body } } } });
	};
	auto body = package();
	CHECK(apply(body, "initial").ok);
	CHECK(preparations == 1 && applications == 1 && last.restart && last.resume);
	CHECK(std::filesystem::exists(paths().surround.projection_root / "test/v2/front_remap.bin"));
	const auto initial_time = std::filesystem::last_write_time(store.exports_index_path());
	CHECK(config.apply(body, true).empty());
	CHECK(preparations == 1 && applications == 1);
	CHECK(std::filesystem::last_write_time(store.exports_index_path()) == initial_time);

	auto& projection = body.at("projections").as_object().at("test").as_object();
	projection.at("surround").as_object().erase("extrinsics");
	projection.at("surround").as_object().at("orbit").as_object().erase("speed");
	CHECK(apply(body, "removed").ok);
	const auto saved = read(store.exports_index_path());
	CHECK(!saved.at("test").as_object().at("surround").as_object().contains("extrinsics"));
	CHECK(!saved.at("test").as_object().at("surround").as_object().at("orbit").as_object().contains("speed"));
	CHECK(!last.restart && (last.changes.at("surround") & LINKER_CONFIG_GEOMETRY));
	CHECK(!(last.changes.at("surround") & LINKER_CONFIG_ORBIT));
	projection.at("surround").as_object().at("orbit").as_object()["interactive"] = true;
	CHECK(apply(body, "orbit").ok && (last.changes.at("surround") & LINKER_CONFIG_ORBIT));

	failure = "injected output failure";
	projection.at("surround").as_object().at("orbit").as_object()["speed"] = 0.5;
	CHECK(!apply(body, "failed").ok);
	CHECK(machine.revision() == "orbit");
	CHECK(std::filesystem::exists(paths().surround.linker_state_root / "config-pending.json"));
	ULinkerConfig recovered(store, nullptr, [](const FLinkerConfigUpdate&) {},
		[&](const FLinkerConfigUpdate& update) { last = update; return std::string{}; });
	CHECK(recovered.apply(body, false).empty());
	CHECK(last.changes.contains("surround") && last.resume);
	failure.clear();
	CHECK(apply(body, "retried").ok);

	const auto good_preset = body.at("presets");
	body.at("presets").as_object().at("preset").as_object().at("cameras").as_object().at("front").as_object()["src_points"] = json::array{};
	CHECK(!apply(body, "bad-bake").ok);
	CHECK(machine.revision() == "retried");
	CHECK(!apply(body, "bad-bake").ok);
	body["presets"] = good_preset;
	CHECK(apply(body, "bake-retried").ok);

	const auto remap_path = paths().surround.projection_root / "test/v2/front_remap.bin";
	std::filesystem::remove(remap_path);
	std::filesystem::create_directory(remap_path);
	projection.at("cameras").as_object()["rear"] = json::object{ { "name", "rear" } };
	const auto rear = body.at("presets").as_object().at("preset").as_object().at("cameras").as_object().at("front");
	body.at("presets").as_object().at("preset").as_object().at("cameras").as_object()["rear"] = rear;
	CHECK(!apply(body, "write-failed").ok);
	CHECK(machine.revision() == "bake-retried");
	std::filesystem::remove(remap_path);
	CHECK(apply(body, "write-retried").ok);

	const auto source = std::filesystem::path(root) / "asset";
	CHECK(write_durable(source, "first image").empty());
	std::string sha = sha256_file(source);
	CHECK(machine.put_asset(sha, "first image").empty());
	projection["_assets"] = json::object{ { "image.png", sha } };
	CHECK(apply(body, "image").ok && last.restart);
	CHECK(write_durable(source, "second image").empty());
	sha = sha256_file(source);
	CHECK(machine.put_asset(sha, "second image").empty());
	projection["_assets"] = json::object{ { "image.png", sha } };
	CHECK(apply(body, "replacement").ok && last.restart);
	CHECK(sha256_file(paths().surround.presets_images / "image.png") == sha);

	body.at("calibrations").as_object()["first"] = calibration("camera_1", 12);
	body.at("calibrations").as_object()["second"] = calibration("camera_2", 25);
	CHECK(apply(body, "calibrations").ok && last.restart);
	const auto first_remap = sha256_file(remap_path);
	body.at("output").as_object().at("configs").as_object().at("test").as_object().at("cameras").as_object()["front"] = "camera_2";
	CHECK(apply(body, "binding").ok && last.restart);
	CHECK(sha256_file(remap_path) != first_remap);
	const auto second_remap = sha256_file(remap_path);
	body.at("calibrations").as_object()["second"] = calibration("camera_2", 30);
	CHECK(apply(body, "implicit-calibration").ok && last.restart);
	CHECK(sha256_file(remap_path) != second_remap);
	const auto geometry_time = std::filesystem::last_write_time(remap_path);
	body.at("calibrations").as_object().at("second").as_object()["name"] = "renamed";
	CHECK(apply(body, "calibration-name").ok && !last.restart);
	CHECK(std::filesystem::last_write_time(remap_path) == geometry_time);

	auto& preset_camera = body.at("presets").as_object().at("preset").as_object().at("cameras").as_object().at("front").as_object();
	preset_camera["camera_id"] = "camera_1";
	preset_camera["calibration"] = "first";
	CHECK(apply(body, "preset-calibration").ok);
	CHECK(!read(store.exports_index_path()).at("test").as_object().at("surround").as_object().contains("calibration"));
	const auto no_op_calls = preparations;
	const auto no_op_time = std::filesystem::last_write_time(remap_path);
	CHECK(config.apply(body, true).empty());
	CHECK(preparations == no_op_calls && std::filesystem::last_write_time(remap_path) == no_op_time);

	projection.at("top").as_object()["calibration"] = json::object{ { "camera_2", "second" } };
	CHECK(apply(body, "top-calibration").ok && last.restart);

	auto legacy = read(store.exports_index_path());
	legacy.at("test").as_object()["active_version"] = "v1";
	write(store.exports_index_path(), legacy);
	projection.at("top").as_object()["plate"] = false;
	CHECK(!apply(body, "legacy-top").ok);
	legacy.at("test").as_object()["active_version"] = "v2";
	write(store.exports_index_path(), legacy);
	projection.at("top").as_object().erase("plate");

	body.at("output").as_object()["active"] = nullptr;
	CHECK(apply(body, "disabled").ok && last.restart);
	CHECK(js::str(read(store.state_path()), "active").empty());

	const auto before_invalid = std::filesystem::last_write_time(store.exports_index_path());
	const auto calls_before_invalid = preparations;
	body.at("output").as_object().at("configs").as_object().at("test").as_object()["fps"] = -1;
	CHECK(!apply(body, "invalid-fps").ok && preparations == calls_before_invalid);
	body.at("output").as_object().at("configs").as_object().at("test").as_object()["fps"] = 25;
	projection["_assets"] = json::object{ { "../escape.png", sha } };
	CHECK(!apply(body, "invalid-path").ok);
	CHECK(preparations == calls_before_invalid && std::filesystem::last_write_time(store.exports_index_path()) == before_invalid);
	projection.erase("_assets");
	CHECK(write_durable(paths().surround.presets_json, "invalid json").empty());
	CHECK(!apply(body, "corrupt-store").ok);
	CHECK(preparations == calls_before_invalid);

	if (argc == 3) {
		init_paths(argv[1], std::filesystem::path(argv[1]) / "archive");
		ULinkerStore backup_store(paths().surround.projection_root, "projection.json", paths().surround.linker_state_root, "state.json", nullptr);
		ULinkerConfig backup_config(backup_store, nullptr,
			[](const FLinkerConfigUpdate&) { CHECK(false); },
			[](const FLinkerConfigUpdate&) { CHECK(false); return std::string{}; });
		const auto backup_part = read(argv[2]);
		const auto error = backup_config.apply(backup_part, true);
		if (!error.empty()) std::fprintf(stderr, "Backup apply: %s\n", error.c_str());
		CHECK(error.empty());
	}
	std::puts("surround-config-check: OK");
}
