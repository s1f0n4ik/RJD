#pragma once

#include <opencv2/core.hpp>
#include <boost/json.hpp>

#include <filesystem>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#include "logger.h"
#include "bird-view/photometric.h"

namespace varan {
namespace birdview {

	/*
		Печка плоской сшивки: карты remap, секторные веса и запись экспорта.

		Версии экспорта - поколения кода печки. v1 - легаси-файлы прямо в
		каталоге экспорта, дальше каталог "v<поколение>". Печка всегда пишет
		в каталог текущего поколения; повторная печка перезаписывает его,
		новая версия появляется только со сменой TOP_BAKE_GENERATION.
	*/
	inline constexpr int TOP_BAKE_GENERATION = 2;
	inline constexpr float TOP_BLEND_DEFAULT = 0.3f;

	inline std::string top_version_key(int generation) {
		return "v" + std::to_string(generation);
	}

	// Активная версия записи; без поля versions запись читается как легаси v1
	inline std::string top_active_version(const boost::json::object& entry) {
		if (auto* v = entry.if_contains("active_version"); v && v->is_string()) {
			return v->as_string().c_str();
		}
		return "v1";
	}

	inline int top_version_generation(const std::string& version_key) {
		if (version_key.size() < 2 || version_key[0] != 'v') return 1;
		try { return std::stoi(version_key.substr(1)); }
		catch (...) { return 1; }
	}

	inline std::filesystem::path top_version_dir(
		const std::filesystem::path& exports_root,
		const std::string& export_id,
		const std::string& version_key)
	{
		if (version_key == "v1") return exports_root / export_id;
		return exports_root / export_id / version_key;
	}

	// Вход печки на камеру: composed remap плюс зона на канвасе
	struct FTopBakeCamera {
		std::string key;
		std::string name;
		// Привязка места из пресета: линкер префиллит ею назначение камер
		std::string camera_id;
		// CV_32FC2, нормированные UV сырого кадра, (-1,-1) - невалидный пиксель
		cv::Mat remap;
		std::vector<cv::Point2f> region;
	};

	class UTopBaker {
	public:
		explicit UTopBaker(ULogger* logger = nullptr) : m_logger(logger) {}

		// Гомография src->dst и карты канвас->источник по её обратной
		static bool build_warp_remap(
			const std::vector<cv::Point2f>& src_points,
			const std::vector<cv::Point2f>& dst_points,
			const cv::Size& canvas_size,
			cv::Mat& out_map_x,
			cv::Mat& out_map_y,
			std::string& error);

		// Склейка warp с undistort и нормализация в [0..1] по сырому кадру
		bool compose_remap_to_raw(
			const cv::Mat& warp_x, const cv::Mat& warp_y,
			const cv::Mat& undist_x, const cv::Mat& undist_y,
			const cv::Size& raw_size,
			cv::Mat& out_remap_32fc2,
			std::string& error);

		static cv::Point2f region_centroid(const std::vector<cv::Point2f>& poly);

		// Выпуклая оболочка: dst-точки не упорядочены и полигоном не заливаются
		static std::vector<cv::Point2f> hull_of(const std::vector<cv::Point2f>& points);

		/*
			Секторные веса Вороного, как у чаши surround: центр сектора -
			центроид зоны камеры, вес clamp((d_чужой - d_свой)/blend + 0.5).
			Камера покрывает пиксель, только когда remap валиден И пиксель
			внутри её полигона зоны - иначе warp мазал бы далеко за регион,
			а картинка зависела бы от порядка применения. Чужими считаются
			только покрывающие камеры: зона без соседа не остаётся дырой.
			Поверх - затухание у края исходного кадра, порог как в surround.
			blend - доля от меньшей стороны канваса. Пустой полигон зоны -
			клипа нет, покрытие только по remap.
		*/
		static void build_weights(
			const cv::Size& canvas,
			const std::vector<cv::Mat>& remaps,
			const std::vector<cv::Point2f>& centers,
			const std::vector<std::vector<cv::Point2f>>& regions,
			float blend,
			std::vector<cv::Mat>& out_weights);

		// Пары точек фотонормализации: пиксели клина смешивания двух камер
		// глазами обеих через их remap; отбор и лимиты как у surround-печки
		static std::vector<FPhotoPair> build_photo_pairs(
			const std::vector<cv::Mat>& remaps,
			const std::vector<cv::Mat>& weights);

		/*
			Запись карт в каталог текущего поколения и мёрж записи индекса:
			width/height/cameras/versions/active_version обновляются, поля из
			record_patch кладутся поверх, всё остальное (surround, top, чужие
			версии) не трогается. blend для весов берётся из top.blend записи.
			calibration_map {camera_id: ключ записи калибровки} мёржится
			по-камерно в surround.calibration - её читает surround-печка.
		*/
		bool save_export(
			const std::filesystem::path& exports_root,
			const std::filesystem::path& index_file,
			const std::string& id,
			const cv::Size& canvas,
			const std::vector<FTopBakeCamera>& cams,
			const boost::json::object& record_patch,
			const boost::json::object& calibration_map,
			std::string& error);

		// Пересчёт из пресета: warp из сохранённых src-точек, undistort из
		// записи калибровки привязанной камеры, результат в текущее поколение
		bool recalc_export(
			const std::filesystem::path& exports_root,
			const std::filesystem::path& index_file,
			const std::string& id,
			const std::filesystem::path& presets_path,
			const std::filesystem::path& calibration_path,
			const std::unordered_map<std::string, std::optional<std::string>>& bindings,
			std::string& error);

		// Перепечка только весов активной версии по её remap.bin
		bool rebake_weights(
			const std::filesystem::path& exports_root,
			const boost::json::object& entry,
			const std::string& id,
			float blend,
			std::string& error);

	private:
		ULogger* m_logger;
	};

} // birdview
} // varan
