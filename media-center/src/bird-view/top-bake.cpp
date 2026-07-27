#include "bird-view/top-bake.h"
#include "bird-view/linker-store.h"

#include "calibration/json-projection.h"
#include "calibration/constants.h"
#include "calibration/utility.h"

#include "utility/gl-maps.h"

#include <opencv2/opencv.hpp>

#include <algorithm>
#include <cmath>
#include <ctime>
#include <fstream>
#include <sstream>

namespace calib = varan::calibration;

namespace varan {
namespace birdview {

	namespace {

		// Затухание веса у края исходного кадра, порог как в surround-шейдере
		inline float border_falloff(float u, float v) {
			const float border = std::min(std::min(u, 1.0f - u), std::min(v, 1.0f - v));
			return std::clamp(border * 8.0f, 0.0f, 1.0f);
		}

		boost::json::object read_json_file(const std::filesystem::path& path) {
			try {
				std::ifstream f(path);
				if (!f) return {};
				std::stringstream ss;
				ss << f.rdbuf();
				auto v = boost::json::parse(ss.str());
				if (v.is_object()) return v.as_object();
			}
			catch (...) {}
			return {};
		}

		bool write_json_file(const std::filesystem::path& path,
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

		cv::Rect region_aabb(const std::vector<cv::Point2f>& pts) {
			if (pts.empty()) return {};
			float min_x = pts[0].x, max_x = pts[0].x;
			float min_y = pts[0].y, max_y = pts[0].y;
			for (const auto& p : pts) {
				min_x = std::min(min_x, p.x);
				max_x = std::max(max_x, p.x);
				min_y = std::min(min_y, p.y);
				max_y = std::max(max_y, p.y);
			}
			return cv::Rect(cvRound(min_x), cvRound(min_y),
				cvRound(max_x - min_x), cvRound(max_y - min_y));
		}

		// Запись калибровки: сырой размер кадра и undistort-карты с диска.
		// Разметка, сделанная без коррекции при живой записи с картами,
		// по экспорту не восстановима - пересчёт всегда берёт карты записи
		struct FCalibMaps {
			cv::Size raw_size;
			cv::Mat undist_x;
			cv::Mat undist_y;
		};

		bool find_calibration_maps(
			const boost::json::object& root,
			const std::string& camera_id,
			const std::string& explicit_key,
			ULogger* logger,
			FCalibMaps& out,
			std::string& error)
		{
			const boost::json::object* entry = nullptr;

			if (!explicit_key.empty()) {
				if (auto* v = root.if_contains(explicit_key); v && v->is_object()) {
					entry = &v->as_object();
				}
				else {
					error = "calibration entry <" + explicit_key + "> not found";
					return false;
				}
			}
			else {
				for (const auto& [key, v] : root) {
					if (!v.is_object()) continue;
					const auto& obj = v.as_object();
					if (auto* id = obj.if_contains("id"); id && id->is_string()
						&& std::string(id->as_string().c_str()) == camera_id) {
						entry = &obj;
						break;
					}
				}
				if (!entry) {
					error = "no calibration entry with id <" + camera_id + ">";
					return false;
				}
			}

			const auto* w = entry->if_contains(calib::constants::JSON_WIDTH);
			const auto* h = entry->if_contains(calib::constants::JSON_HEIGHT);
			if (!w || !h || !w->is_number() || !h->is_number()) {
				error = "calibration entry: missing frame size";
				return false;
			}
			out.raw_size = {
				static_cast<int>(w->to_number<int64_t>()),
				static_cast<int>(h->to_number<int64_t>())
			};

			// Карты необязательны: без коррекции warp указывает в сырой кадр
			const auto* mx = entry->if_contains(calib::constants::JSON_UNDISTORTION_MAP_X);
			const auto* my = entry->if_contains(calib::constants::JSON_UNDISTORTION_MAP_Y);
			if (mx && my && mx->is_string() && my->is_string()) {
				const std::filesystem::path maps_root = calib::constants::CALIBRATION_MAPS_PATH;
				if (!calib::utility::SBinary::load_mat_from_binary(
						maps_root / std::string(mx->as_string().c_str()), out.undist_x, logger)
					|| !calib::utility::SBinary::load_mat_from_binary(
						maps_root / std::string(my->as_string().c_str()), out.undist_y, logger))
				{
					out.undist_x.release();
					out.undist_y.release();
					if (logger) logger->warn("find_calibration_maps(): undistort maps unreadable, "
						"composing without correction");
				}
			}
			return true;
		}

	} // namespace

	bool UTopBaker::build_warp_remap(
		const std::vector<cv::Point2f>& src_points,
		const std::vector<cv::Point2f>& dst_points,
		const cv::Size& canvas_size,
		cv::Mat& out_map_x,
		cv::Mat& out_map_y,
		std::string& error)
	{
		if (src_points.size() != dst_points.size() || src_points.size() < 4) {
			error = "build_warp_remap(): need >= 4 matching points, got " +
				std::to_string(src_points.size()) + "/" +
				std::to_string(dst_points.size());
			return false;
		}
		if (canvas_size.width <= 0 || canvas_size.height <= 0) {
			error = "build_warp_remap(): invalid canvas size";
			return false;
		}

		cv::Mat H;
		if (src_points.size() == 4) {
			H = cv::getPerspectiveTransform(src_points, dst_points);
		}
		else {
			H = cv::findHomography(src_points, dst_points, 0);
		}
		if (H.empty()) {
			error = "build_warp_remap(): homography computation failed";
			return false;
		}

		// Карты строятся обратным преобразованием: пиксель канваса - точка источника
		cv::Mat H_inv;
		if (!cv::invert(H, H_inv)) {
			error = "build_warp_remap(): H is degenerate";
			return false;
		}

		const int W = canvas_size.width;
		const int H_px = canvas_size.height;

		std::vector<cv::Point2f> grid;
		grid.reserve(static_cast<size_t>(W) * H_px);
		for (int y = 0; y < H_px; ++y) {
			for (int x = 0; x < W; ++x) {
				grid.emplace_back(static_cast<float>(x), static_cast<float>(y));
			}
		}

		std::vector<cv::Point2f> mapped;
		cv::perspectiveTransform(grid, mapped, H_inv);

		out_map_x.create(canvas_size, CV_32FC1);
		out_map_y.create(canvas_size, CV_32FC1);

		for (int y = 0; y < H_px; ++y) {
			float* row_x = out_map_x.ptr<float>(y);
			float* row_y = out_map_y.ptr<float>(y);
			const cv::Point2f* src_row = mapped.data() + static_cast<size_t>(y) * W;
			for (int x = 0; x < W; ++x) {
				row_x[x] = src_row[x].x;
				row_y[x] = src_row[x].y;
			}
		}

		return true;
	}

	bool UTopBaker::compose_remap_to_raw(
		const cv::Mat& warp_x, const cv::Mat& warp_y,
		const cv::Mat& undist_x, const cv::Mat& undist_y,
		const cv::Size& raw_size,
		cv::Mat& out_remap_32fc2,
		std::string& error)
	{
		if (warp_x.empty() || warp_y.empty() || warp_x.size() != warp_y.size() ||
			warp_x.type() != CV_32FC1 || warp_y.type() != CV_32FC1)
		{
			error = "compose_remap_to_raw(): bad warp maps";
			return false;
		}

		if (raw_size.width <= 0 || raw_size.height <= 0) {
			error = "compose_remap_to_raw(): bad raw size";
			return false;
		}

		const cv::Size canvas_size = warp_x.size();
		const bool has_undistort = !undist_x.empty() && !undist_y.empty()
			&& undist_x.size() == undist_y.size();

		out_remap_32fc2.create(canvas_size, CV_32FC2);

		const float inv_W = 1.0f / static_cast<float>(raw_size.width);
		const float inv_H = 1.0f / static_cast<float>(raw_size.height);

		if (has_undistort) {
			// Undistort-карты приводятся к единой CV_32FC2: float-пара мерджится,
			// fixed-point (CV_16SC2 + CV_16UC1) конвертируется convertMaps
			cv::Mat undist_xy;
			if (undist_x.type() == CV_32FC1 && undist_y.type() == CV_32FC1) {
				std::vector<cv::Mat> ch{ undist_x, undist_y };
				cv::merge(ch, undist_xy);
			}
			else {
				cv::Mat dummy;
				cv::convertMaps(undist_x, undist_y, undist_xy, dummy, CV_32FC2, false);
			}

			cv::Mat composed;
			cv::remap(undist_xy, composed, warp_x, warp_y, cv::INTER_LINEAR, cv::BORDER_REPLICATE);

			for (int y = 0; y < canvas_size.height; ++y) {
				const cv::Vec2f* in_row = composed.ptr<cv::Vec2f>(y);
				cv::Vec2f* out_row = out_remap_32fc2.ptr<cv::Vec2f>(y);
				for (int x = 0; x < canvas_size.width; ++x) {
					const float rx = in_row[x][0];
					const float ry = in_row[x][1];

					const float clamped_x = std::min(std::max(rx, 0.0f), static_cast<float>(raw_size.width - 1));
					const float clamped_y = std::min(std::max(ry, 0.0f), static_cast<float>(raw_size.height - 1));

					out_row[x] = cv::Vec2f(clamped_x * inv_W, clamped_y * inv_H);
				}
			}
		}
		else {
			if (m_logger) m_logger->debug("compose_remap_to_raw(): no undistort maps, simple compose");
			// Без undistort: warp уже указывает в сырой кадр напрямую
			for (int y = 0; y < canvas_size.height; ++y) {
				const float* wx_row = warp_x.ptr<float>(y);
				const float* wy_row = warp_y.ptr<float>(y);
				cv::Vec2f* out = out_remap_32fc2.ptr<cv::Vec2f>(y);
				for (int x = 0; x < canvas_size.width; ++x) {
					const float rx = wx_row[x];
					const float ry = wy_row[x];
					if (rx < 0.0f || ry < 0.0f ||
						rx >= raw_size.width || ry >= raw_size.height)
					{
						out[x] = cv::Vec2f(-1.0f, -1.0f);
					}
					else {
						out[x] = cv::Vec2f(rx * inv_W, ry * inv_H);
					}
				}
			}
		}

		return true;
	}

	cv::Point2f UTopBaker::region_centroid(const std::vector<cv::Point2f>& poly) {
		if (poly.empty()) return { 0.0f, 0.0f };
		// Центроид площади полигона; вырожденный - среднее вершин
		double area2 = 0.0, cx = 0.0, cy = 0.0;
		for (size_t i = 0; i < poly.size(); ++i) {
			const auto& a = poly[i];
			const auto& b = poly[(i + 1) % poly.size()];
			const double cross = static_cast<double>(a.x) * b.y - static_cast<double>(b.x) * a.y;
			area2 += cross;
			cx += (a.x + b.x) * cross;
			cy += (a.y + b.y) * cross;
		}
		if (std::fabs(area2) > 1e-6) {
			return { static_cast<float>(cx / (3.0 * area2)),
				static_cast<float>(cy / (3.0 * area2)) };
		}
		cv::Point2f sum{ 0.0f, 0.0f };
		for (const auto& p : poly) sum += p;
		return { sum.x / poly.size(), sum.y / poly.size() };
	}

	std::vector<cv::Point2f> UTopBaker::hull_of(const std::vector<cv::Point2f>& points) {
		if (points.size() < 3) return points;
		std::vector<cv::Point2f> hull;
		cv::convexHull(points, hull);
		return hull;
	}

	void UTopBaker::build_weights(
		const cv::Size& canvas,
		const std::vector<cv::Mat>& remaps,
		const std::vector<cv::Point2f>& centers,
		const std::vector<std::vector<cv::Point2f>>& regions,
		float blend,
		std::vector<cv::Mat>& out_weights)
	{
		const size_t n = remaps.size();
		out_weights.assign(n, cv::Mat());
		for (auto& m : out_weights) m = cv::Mat::zeros(canvas, CV_32FC1);
		if (n == 0) return;

		const float blend_px = std::max(1.0f,
			blend * static_cast<float>(std::min(canvas.width, canvas.height)));

		// Маски зон: за пределами своего полигона камера пикселей не имеет
		std::vector<cv::Mat> masks(n);
		for (size_t i = 0; i < n; ++i) {
			if (i < regions.size() && regions[i].size() >= 3) {
				masks[i] = cv::Mat::zeros(canvas, CV_8UC1);
				std::vector<cv::Point> poly;
				poly.reserve(regions[i].size());
				for (const auto& p : regions[i]) {
					poly.emplace_back(cvRound(p.x), cvRound(p.y));
				}
				std::vector<std::vector<cv::Point>> polys{ std::move(poly) };
				cv::fillPoly(masks[i], polys, cv::Scalar(255));
			}
			else {
				masks[i] = cv::Mat(canvas, CV_8UC1, cv::Scalar(255));
			}
		}

		std::vector<const cv::Vec2f*> rows(n, nullptr);
		std::vector<const uchar*> mask_rows(n, nullptr);
		std::vector<float*> out_rows(n, nullptr);
		std::vector<float> dist(n, 0.0f);
		std::vector<char> valid(n, 0);

		for (int y = 0; y < canvas.height; ++y) {
			for (size_t i = 0; i < n; ++i) {
				rows[i] = remaps[i].ptr<cv::Vec2f>(y);
				mask_rows[i] = masks[i].ptr<uchar>(y);
				out_rows[i] = out_weights[i].ptr<float>(y);
			}
			for (int x = 0; x < canvas.width; ++x) {
				int covered = 0;
				for (size_t i = 0; i < n; ++i) {
					const cv::Vec2f uv = rows[i][x];
					valid[i] = (mask_rows[i][x] && uv[0] >= 0.0f && uv[1] >= 0.0f) ? 1 : 0;
					if (valid[i]) {
						const float dx = static_cast<float>(x) - centers[i].x;
						const float dy = static_cast<float>(y) - centers[i].y;
						dist[i] = std::sqrt(dx * dx + dy * dy);
						++covered;
					}
				}
				if (covered == 0) continue;

				for (size_t i = 0; i < n; ++i) {
					if (!valid[i]) continue;
					float w = 1.0f;
					if (covered > 1) {
						float d_other = std::numeric_limits<float>::max();
						for (size_t j = 0; j < n; ++j) {
							if (j == i || !valid[j]) continue;
							d_other = std::min(d_other, dist[j]);
						}
						w = std::clamp((d_other - dist[i]) / blend_px + 0.5f, 0.0f, 1.0f);
					}
					if (w <= 0.0f) continue;
					const cv::Vec2f uv = rows[i][x];
					out_rows[i][x] = w * border_falloff(uv[0], uv[1]);
				}
			}
		}
	}

	std::vector<FPhotoPair> UTopBaker::build_photo_pairs(
		const std::vector<cv::Mat>& remaps,
		const std::vector<cv::Mat>& weights)
	{
		std::vector<FPhotoPair> pairs;
		const size_t n = remaps.size();
		if (n < 2 || weights.size() != n) return pairs;

		for (size_t a = 0; a < n; ++a) {
			for (size_t b = a + 1; b < n; ++b) {
				if (remaps[a].empty() || remaps[b].empty()
					|| weights[a].empty() || weights[b].empty()) continue;
				if (remaps[a].size() != remaps[b].size()) continue;

				std::vector<std::array<float, 4>> candidates;
				// Шаг 2: клин шва и так даёт тысячи точек, полный обход лишний
				for (int y = 0; y < remaps[a].rows; y += 2) {
					const cv::Vec2f* ra = remaps[a].ptr<cv::Vec2f>(y);
					const cv::Vec2f* rb = remaps[b].ptr<cv::Vec2f>(y);
					const uchar* wa = weights[a].ptr<uchar>(y);
					const uchar* wb = weights[b].ptr<uchar>(y);
					for (int x = 0; x < remaps[a].cols; x += 2) {
						const float fa = wa[x] / 255.0f;
						const float fb = wb[x] / 255.0f;
						if (fa <= 0.02f || fa >= 0.98f || fb <= 0.02f || fb >= 0.98f) continue;
						const cv::Vec2f ua = ra[x];
						const cv::Vec2f ub = rb[x];
						// Отступ от краёв кадра, как у surround-печки
						if (ua[0] < 0.02f || ua[0] > 0.98f || ua[1] < 0.02f || ua[1] > 0.98f) continue;
						if (ub[0] < 0.02f || ub[0] > 0.98f || ub[1] < 0.02f || ub[1] > 0.98f) continue;
						candidates.push_back({ ua[0], ua[1], ub[0], ub[1] });
					}
				}
				if (candidates.size() < 16) continue;

				FPhotoPair pair;
				pair.cam_a = static_cast<int>(a);
				pair.cam_b = static_cast<int>(b);
				const size_t take = std::min<size_t>(candidates.size(), PHOTO_SAMPLES);
				const double step = static_cast<double>(candidates.size()) / take;
				pair.uv.reserve(take);
				for (size_t s = 0; s < take; ++s) {
					pair.uv.push_back(candidates[static_cast<size_t>(s * step)]);
				}
				pairs.push_back(std::move(pair));
			}
		}
		return pairs;
	}

	bool UTopBaker::save_export(
		const std::filesystem::path& exports_root,
		const std::filesystem::path& index_file,
		const std::string& id,
		const cv::Size& canvas,
		const std::vector<FTopBakeCamera>& cams,
		const boost::json::object& record_patch,
		const boost::json::object& calibration_map,
		std::string& error)
	{
		if (id.empty() || cams.empty()) {
			error = "save_export(): empty id or cameras";
			return false;
		}
		if (canvas.width <= 0 || canvas.height <= 0) {
			error = "save_export(): invalid canvas size";
			return false;
		}

		const auto index_path = exports_root / index_file;
		auto root = read_json_file(index_path);

		boost::json::object record;
		const bool existed = root.if_contains(id) && root.at(id).is_object();
		if (existed) record = root.at(id).as_object();

		// Ширина шва пользователя переживает пересчёт
		float blend = TOP_BLEND_DEFAULT;
		if (auto* top = js::obj(record, "top")) {
			const double b = js::num(*top, "blend", TOP_BLEND_DEFAULT);
			if (b > 0) blend = static_cast<float>(b);
		}

		const std::string vkey = top_version_key(TOP_BAKE_GENERATION);
		const auto dir = top_version_dir(exports_root, id, vkey);
		try {
			std::filesystem::create_directories(dir);
		}
		catch (const std::exception& e) {
			error = std::string("save_export(): ") + e.what();
			return false;
		}

		// Секторные веса считаются по всем камерам разом
		std::vector<cv::Mat> remaps;
		std::vector<cv::Point2f> centers;
		std::vector<std::vector<cv::Point2f>> regions;
		remaps.reserve(cams.size());
		centers.reserve(cams.size());
		regions.reserve(cams.size());
		for (const auto& cam : cams) {
			remaps.push_back(cam.remap);
			centers.push_back(cam.region.empty()
				? cv::Point2f(canvas.width * 0.5f, canvas.height * 0.5f)
				: region_centroid(cam.region));
			regions.push_back(cam.region);
		}
		std::vector<cv::Mat> weights;
		build_weights(canvas, remaps, centers, regions, blend, weights);

		boost::json::object cameras_json;
		int exported = 0;
		for (size_t i = 0; i < cams.size(); ++i) {
			const auto& cam = cams[i];
			const std::string remap_name = cam.key + "_remap.bin";
			const std::string weight_name = cam.key + "_weight.bin";

			cv::Mat weight_u8;
			weights[i].convertTo(weight_u8, CV_8UC1, 255.0);

			if (!gl_maps::save_remap(dir / remap_name, cam.remap)) {
				if (m_logger) m_logger->error("save_export(): cannot write "
					+ (dir / remap_name).string());
				continue;
			}
			if (!gl_maps::save_weight(dir / weight_name, weight_u8)) {
				if (m_logger) m_logger->error("save_export(): cannot write "
					+ (dir / weight_name).string());
				continue;
			}

			boost::json::object cam_obj;
			const auto rel = std::filesystem::path(id) / vkey;
			cam_obj["remap"] = (rel / remap_name).generic_string();
			cam_obj["weight"] = (rel / weight_name).generic_string();
			cam_obj["name"] = cam.name;
			if (!cam.camera_id.empty()) cam_obj["camera_id"] = cam.camera_id;

			if (!cam.region.empty()) {
				const cv::Rect region = region_aabb(cam.region);
				if (region.width > 0 && region.height > 0) {
					cam_obj["region"] = boost::json::array{
						region.x, region.y, region.width, region.height };
				}
				const cv::Point2f c = centers[i];
				cam_obj["center"] = boost::json::array{ c.x, c.y };
				// Полигон зоны целиком: перепечка весов клипует по нему,
				// не поднимая пресет
				boost::json::array poly;
				for (const auto& p : cam.region) {
					poly.push_back(boost::json::array{ p.x, p.y });
				}
				cam_obj["region_poly"] = std::move(poly);
			}
			else if (m_logger) {
				m_logger->warn("save_export(): no region for <" + cam.key + ">");
			}

			cameras_json[cam.key] = std::move(cam_obj);
			++exported;
		}
		if (exported == 0) {
			error = "save_export(): nothing exported";
			return false;
		}

		record["width"] = canvas.width;
		record["height"] = canvas.height;
		record["cameras"] = std::move(cameras_json);

		// Список версий: легаси-запись без поля versions - это файлы v1
		boost::json::array versions;
		if (auto* v = js::arr(record, "versions")) versions = *v;
		else if (existed) {
			versions.push_back(boost::json::object{ {"key", "v1"}, {"created", 0} });
		}
		bool found = false;
		for (auto& v : versions) {
			if (v.is_object() && js::str(v.as_object(), "key") == vkey) {
				v.as_object()["created"] = static_cast<int64_t>(std::time(nullptr));
				found = true;
			}
		}
		if (!found) {
			versions.push_back(boost::json::object{
				{"key", vkey},
				{"created", static_cast<int64_t>(std::time(nullptr))} });
		}
		record["versions"] = std::move(versions);
		record["active_version"] = vkey;

		for (const auto& kv : record_patch) {
			record[kv.key()] = kv.value();
		}

		/*
			Surround-блок заводится прямо при экспорте: печка объёмного вида
			требует surround.preset, и без блока не работают ни рендер, ни
			ручки /linker/surround. Мёрж, а не замена: настройки пользователя
			(чаша, орбита, extrinsics) переживают перезапись экспорта.
			Карта калибровки мёржится по-камерно: ручные записи для камер,
			которых нет в пресете, не затираются.
		*/
		{
			boost::json::object surround;
			if (auto* s = js::obj(record, "surround")) surround = *s;
			if (auto* p = record.if_contains("preset"); p && p->is_string()) {
				surround["preset"] = *p;
			}
			if (!calibration_map.empty()) {
				boost::json::object calib;
				if (auto* c = js::obj(surround, "calibration")) calib = *c;
				for (const auto& kv : calibration_map) calib[kv.key()] = kv.value();
				surround["calibration"] = std::move(calib);
			}
			if (!surround.empty()) record["surround"] = std::move(surround);
		}

		root[id] = std::move(record);
		if (!write_json_file(index_path, root, error)) return false;

		if (m_logger) m_logger->info("save_export(): <" + id + "> " + vkey
			+ ", cameras=" + std::to_string(exported)
			+ ", blend=" + std::to_string(blend));
		return true;
	}

	bool UTopBaker::recalc_export(
		const std::filesystem::path& exports_root,
		const std::filesystem::path& index_file,
		const std::string& id,
		const std::filesystem::path& presets_path,
		const std::filesystem::path& calibration_path,
		const std::unordered_map<std::string, std::optional<std::string>>& bindings,
		std::string& error)
	{
		auto root = read_json_file(exports_root / index_file);
		const auto* entry_v = root.if_contains(id);
		if (!entry_v || !entry_v->is_object()) {
			error = "export <" + id + "> not found";
			return false;
		}
		const auto& entry = entry_v->as_object();

		const std::string preset_key = js::str(entry, "preset");
		if (preset_key.empty()) {
			error = "export has no preset key, re-export it from the projection page";
			return false;
		}

		calib::UJsonProjectionConfiguration presets(m_logger);
		if (!presets.read(presets_path.string())) {
			error = "cannot read presets at " + presets_path.string();
			return false;
		}
		auto preset = presets.load_preset(preset_key);
		if (!preset) {
			error = "preset <" + preset_key + "> not found";
			return false;
		}
		const cv::Size canvas = preset->canvas_size;
		if (canvas.width <= 0 || canvas.height <= 0) {
			error = "preset <" + preset_key + "> has invalid canvas";
			return false;
		}

		const auto calib_root = read_json_file(calibration_path);

		// Необязательная карта camera_id - ключ записи калибровки;
		// свой блок top главнее, фолбэк - карта surround из «Рассчитать LUT»
		boost::json::object calib_keys;
		if (auto* top = js::obj(entry, "top")) {
			if (auto* v = js::obj(*top, "calibration")) calib_keys = *v;
		}
		if (calib_keys.empty()) {
			if (auto* s = js::obj(entry, "surround")) {
				if (auto* v = js::obj(*s, "calibration")) calib_keys = *v;
			}
		}

		const auto* cams_rec = js::obj(entry, "cameras");
		if (!cams_rec || cams_rec->empty()) {
			error = "export has no cameras";
			return false;
		}

		std::vector<FTopBakeCamera> cams;
		for (const auto& [key_sv, _] : *cams_rec) {
			const std::string place_key(key_sv);
			auto cam_it = preset->cameras.find(place_key);
			if (cam_it == preset->cameras.end()) {
				error = "camera <" + place_key + "> is missing in preset <" + preset_key + ">";
				return false;
			}
			const auto& cam = cam_it->second;
			if (cam.src_points.size() < 4 || cam.src_points.size() != cam.dst_points.size()) {
				error = "camera <" + place_key + "> has no saved src points";
				return false;
			}

			std::string camera_id;
			if (auto b = bindings.find(place_key); b != bindings.end() && b->second) {
				camera_id = *b->second;
			}
			// Ключ из пресета свежее карты записи: он записан вместе с точками
			std::string explicit_key = cam.calibration_key;
			if (explicit_key.empty()) {
				if (auto* v = calib_keys.if_contains(camera_id); v && v->is_string()) {
					explicit_key = v->as_string().c_str();
				}
			}

			FCalibMaps calib_maps;
			std::string calib_error;
			const bool has_calib = (!camera_id.empty() || !explicit_key.empty())
				&& find_calibration_maps(calib_root, camera_id, explicit_key,
					m_logger, calib_maps, calib_error);

			cv::Mat remap_norm;
			if (has_calib) {
				// src нормированы на кадре камеры; в пиксели по размеру записи
				std::vector<cv::Point2f> src_abs = cam.src_points;
				for (auto& p : src_abs) {
					p.x *= static_cast<float>(calib_maps.raw_size.width);
					p.y *= static_cast<float>(calib_maps.raw_size.height);
				}
				cv::Mat mx, my;
				if (!build_warp_remap(src_abs, cam.dst_points, canvas, mx, my, error)) {
					error = "camera <" + place_key + ">: " + error;
					return false;
				}
				if (!compose_remap_to_raw(mx, my, calib_maps.undist_x, calib_maps.undist_y,
					calib_maps.raw_size, remap_norm, error)) {
					error = "camera <" + place_key + ">: " + error;
					return false;
				}
			}
			else {
				if (m_logger) m_logger->warn("recalc_export(): camera <" + place_key
					+ ">: " + (calib_error.empty() ? "no bound camera" : calib_error)
					+ ", building without undistort");
				// Без записи калибровки гомография строится сразу в нормированных
				// координатах: размер сырого кадра неизвестен и не нужен
				cv::Mat mx, my;
				if (!build_warp_remap(cam.src_points, cam.dst_points, canvas, mx, my, error)) {
					error = "camera <" + place_key + ">: " + error;
					return false;
				}
				remap_norm.create(canvas, CV_32FC2);
				for (int y = 0; y < canvas.height; ++y) {
					const float* rx = mx.ptr<float>(y);
					const float* ry = my.ptr<float>(y);
					cv::Vec2f* out = remap_norm.ptr<cv::Vec2f>(y);
					for (int x = 0; x < canvas.width; ++x) {
						if (rx[x] < 0.0f || rx[x] > 1.0f || ry[x] < 0.0f || ry[x] > 1.0f) {
							out[x] = cv::Vec2f(-1.0f, -1.0f);
						}
						else {
							out[x] = cv::Vec2f(rx[x], ry[x]);
						}
					}
				}
			}

			FTopBakeCamera baked;
			baked.key = place_key;
			baked.name = cam.name;
			baked.camera_id = cam.camera_id;
			baked.remap = std::move(remap_norm);
			baked.region = !cam.canvas_region.empty()
				? cam.canvas_region : hull_of(cam.dst_points);
			cams.push_back(std::move(baked));
		}

		// Карта калибровки из пресета: по привязанным камерам с ключом
		boost::json::object calib_map;
		for (const auto& [place_key, cam] : preset->cameras) {
			if (!cam.camera_id.empty() && !cam.calibration_key.empty()) {
				calib_map[cam.camera_id] = cam.calibration_key;
			}
		}

		boost::json::object patch;
		patch["preset"] = preset_key;
		return save_export(exports_root, index_file, id, canvas, cams, patch, calib_map, error);
	}

	bool UTopBaker::rebake_weights(
		const std::filesystem::path& exports_root,
		const boost::json::object& entry,
		const std::string& id,
		float blend,
		std::string& error)
	{
		const auto* cams_rec = js::obj(entry, "cameras");
		if (!cams_rec || cams_rec->empty()) {
			error = "export has no cameras";
			return false;
		}

		const std::string vkey = top_active_version(entry);
		const auto dir = top_version_dir(exports_root, id, vkey);
		const double canvas_w = js::num(entry, "width", 0);
		const double canvas_h = js::num(entry, "height", 0);
		if (canvas_w <= 0 || canvas_h <= 0) {
			error = "export has invalid canvas size";
			return false;
		}
		const cv::Size canvas{ static_cast<int>(canvas_w), static_cast<int>(canvas_h) };

		std::vector<std::string> keys;
		std::vector<cv::Mat> remaps;
		std::vector<cv::Point2f> centers;
		std::vector<std::vector<cv::Point2f>> regions;
		for (const auto& [key_sv, cam_v] : *cams_rec) {
			const std::string key(key_sv);
			cv::Mat remap = gl_maps::load_remap_mat(dir / (key + "_remap.bin"));
			if (remap.empty() || remap.size() != canvas) {
				error = "cannot read remap for camera <" + key + ">";
				return false;
			}

			// Центр сектора и полигон зоны из записи, для легаси - рект зоны
			cv::Point2f center{ canvas.width * 0.5f, canvas.height * 0.5f };
			std::vector<cv::Point2f> region;
			if (cam_v.is_object()) {
				const auto& cam_obj = cam_v.as_object();
				if (const auto* c = js::arr(cam_obj, "center"); c && c->size() == 2) {
					center = { static_cast<float>(c->at(0).to_number<double>()),
						static_cast<float>(c->at(1).to_number<double>()) };
				}
				else if (const auto* r = js::arr(cam_obj, "region"); r && r->size() == 4) {
					center = {
						static_cast<float>(r->at(0).to_number<double>() + r->at(2).to_number<double>() * 0.5),
						static_cast<float>(r->at(1).to_number<double>() + r->at(3).to_number<double>() * 0.5) };
				}

				if (const auto* poly = js::arr(cam_obj, "region_poly"); poly && poly->size() >= 3) {
					for (const auto& p : *poly) {
						if (!p.is_array() || p.as_array().size() < 2) continue;
						region.emplace_back(
							static_cast<float>(p.as_array().at(0).to_number<double>()),
							static_cast<float>(p.as_array().at(1).to_number<double>()));
					}
				}
				else if (const auto* r = js::arr(cam_obj, "region"); r && r->size() == 4) {
					const float rx = static_cast<float>(r->at(0).to_number<double>());
					const float ry = static_cast<float>(r->at(1).to_number<double>());
					const float rw = static_cast<float>(r->at(2).to_number<double>());
					const float rh = static_cast<float>(r->at(3).to_number<double>());
					region = { { rx, ry }, { rx + rw, ry },
						{ rx + rw, ry + rh }, { rx, ry + rh } };
				}
			}

			keys.push_back(key);
			remaps.push_back(std::move(remap));
			centers.push_back(center);
			regions.push_back(std::move(region));
		}

		std::vector<cv::Mat> weights;
		build_weights(canvas, remaps, centers, regions, blend, weights);

		for (size_t i = 0; i < keys.size(); ++i) {
			cv::Mat weight_u8;
			weights[i].convertTo(weight_u8, CV_8UC1, 255.0);
			const auto path = dir / (keys[i] + "_weight.bin");
			if (!gl_maps::save_weight(path, weight_u8)) {
				error = "cannot write " + path.string();
				return false;
			}
		}

		if (m_logger) m_logger->info("rebake_weights(): <" + id + "> " + vkey
			+ ", blend=" + std::to_string(blend));
		return true;
	}

} // birdview
} // varan
