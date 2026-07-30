#pragma once

#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <vector>

namespace varan {

/*
	Раскладка рабочего каталога приложения.

	Раньше пути были inline-константами в constants.h каждой подсистемы и
	считались до входа в main — поэтому не могли зависеть от аргументов запуска.
	Здесь они заполняются один раз явным вызовом init_paths() сразу после
	разбора argv.

	<varan_root>/
	    nvr/configurations.json
	    neural/{configurations.json, state.json, loader_state.json, models/}
	    surround_view/
	        calibration/{calibration_settings.json, links.json, maps/}
	        presets/{presets.json, images/, models/}
	        projection/
	        linker/

	Журнал обнаружений задаётся отдельно: он живёт на своём томе (/storage).
*/
struct FPaths {
	struct FNvr {
		std::filesystem::path config;
	} nvr;

	struct FNeural {
		std::filesystem::path config;
		std::filesystem::path state;
		std::filesystem::path loader_state;
		std::filesystem::path models;
	} neural;

	struct FSurround {
		std::filesystem::path root;
		std::filesystem::path calibration_settings;
		std::filesystem::path calibration_maps;
		std::filesystem::path calibration_links;
		std::filesystem::path presets_json;
		std::filesystem::path presets_images;
		std::filesystem::path presets_models;
		std::filesystem::path projection_root;
		std::filesystem::path linker_state_root;
	} surround;

	std::filesystem::path journal;
};

namespace detail {

	inline FPaths& mutable_paths() {
		static FPaths instance;
		return instance;
	}

	inline bool& paths_initialized() {
		static bool initialized = false;
		return initialized;
	}

} // detail

// Заполняет раскладку. Вызывается ровно один раз, до создания подсистем.
inline void init_paths(
	const std::filesystem::path& varan_root,
	const std::filesystem::path& journal_dir
) {
	FPaths& p = detail::mutable_paths();

	p.nvr.config = varan_root / "nvr" / "configurations.json";

	const std::filesystem::path neural_root = varan_root / "neural";
	p.neural.config       = neural_root / "configurations.json";
	p.neural.state        = neural_root / "state.json";
	p.neural.loader_state = neural_root / "loader_state.json";
	p.neural.models       = neural_root / "models";

	const std::filesystem::path surround_root = varan_root / "surround_view";
	p.surround.root                 = surround_root;
	p.surround.calibration_settings = surround_root / "calibration" / "calibration_settings.json";
	p.surround.calibration_maps     = surround_root / "calibration" / "maps";
	p.surround.calibration_links    = surround_root / "calibration" / "links.json";
	p.surround.presets_json         = surround_root / "presets" / "presets.json";
	p.surround.presets_images       = surround_root / "presets" / "images";
	p.surround.presets_models       = surround_root / "presets" / "models";
	p.surround.projection_root      = surround_root / "projection";
	p.surround.linker_state_root    = surround_root / "linker";

	p.journal = journal_dir;

	detail::paths_initialized() = true;
}

// Обращение до init_paths() — ошибка программиста, а не рантайма.
inline const FPaths& paths() {
	if (!detail::paths_initialized()) {
		std::cerr << "FATAL: varan::paths() used before init_paths()" << std::endl;
		std::abort();
	}
	return detail::mutable_paths();
}

// Каталоги, которые приложение создаёт при старте.
inline std::vector<std::filesystem::path> required_directories() {
	const FPaths& p = paths();
	return {
		p.nvr.config.parent_path(),
		p.neural.config.parent_path(),
		p.neural.models,
		p.surround.calibration_settings.parent_path(),
		p.surround.calibration_maps,
		p.surround.presets_json.parent_path(),
		p.surround.presets_images,
		p.surround.presets_models,
		p.surround.projection_root,
		p.surround.linker_state_root,
	};
}

} // varan
