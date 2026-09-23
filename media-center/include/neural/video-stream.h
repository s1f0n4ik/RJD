#pragma once

#include <algorithm>
#include <cmath>
#include <set>
#include <string>
#include <vector>

#include <boost/json.hpp>
#include <opencv2/core.hpp>

#include "neural/detection.h"

namespace varan {
namespace neural {

	enum class ETileFit { LETTERBOX, STRETCH };

	// Ячейка сетки видеопотока: камера, место в сетке, окно кадра и способ вписывания
	struct FStreamTile {
		std::string camera;
		int row = 0;
		int col = 0;
		int row_span = 1;
		int col_span = 1;
		// Окно кадра источника в долях [0..1]
		cv::Rect2f crop{ 0.f, 0.f, 1.f, 1.f };
		ETileFit fit = ETileFit::LETTERBOX;
	};

	// Видеопоток: полотно размером с вход модели, собранное из тайлов камер
	struct FVideoStream {
		std::string id;
		std::string name;
		std::string config_id;
		// Размер входа модели конфигурации на момент сохранения
		int width = 640;
		int height = 640;
		int rows = 1;
		int cols = 1;
		// Веса дорожек; пустой вектор — все по единице
		std::vector<float> row_fr;
		std::vector<float> col_fr;
		std::vector<FStreamTile> tiles;
	};

	enum class ETileState { OK, NO_CAMERA, STALLED };

	inline const char* tile_state_str(ETileState s) {
		switch (s) {
		case ETileState::OK: return "ok";
		case ETileState::NO_CAMERA: return "no_camera";
		case ETileState::STALLED: return "stalled";
		}
		return "unknown";
	}

	// Размещение тайла на полотне за конкретный тик: ячейка, область картинки и размер источника
	struct FTilePlacement {
		std::string camera;
		cv::Rect cell;
		// Область ячейки, занятая картинкой; при letterbox уже ячейки
		cv::Rect dst;
		cv::Rect2f crop{ 0.f, 0.f, 1.f, 1.f };
		int cam_w = 0;
		int cam_h = 0;
		ETileState state = ETileState::NO_CAMERA;
	};

	inline std::vector<std::string> stream_cameras(const FVideoStream& s) {
		std::vector<std::string> out;
		for (const auto& t : s.tiles)
			if (!t.camera.empty() && std::find(out.begin(), out.end(), t.camera) == out.end())
				out.push_back(t.camera);
		return out;
	}

	// allow_empty — редактор держит сетку без тайлов, пока оператор её заполняет
	inline bool is_valid_stream(const FVideoStream& s, std::string* err = nullptr, bool allow_empty = false) {
		auto fail = [&](const std::string& m) { if (err) *err = m; return false; };
		if (s.id.empty()) return fail("stream id is empty");
		if (s.width < 1 || s.height < 1) return fail("canvas size invalid");
		if (s.rows < 1 || s.cols < 1) return fail("grid dimensions invalid");
		if (!s.row_fr.empty() && (int)s.row_fr.size() != s.rows) return fail("row_fr size differs from rows");
		if (!s.col_fr.empty() && (int)s.col_fr.size() != s.cols) return fail("col_fr size differs from cols");
		for (float f : s.row_fr) if (!(f > 0.f)) return fail("row_fr must be positive");
		for (float f : s.col_fr) if (!(f > 0.f)) return fail("col_fr must be positive");
		if (s.tiles.empty()) return allow_empty ? true : fail("stream has no tiles");

		std::vector<char> used(static_cast<size_t>(s.rows) * s.cols, 0);
		for (const auto& t : s.tiles) {
			if (t.camera.empty()) return fail("empty camera in tile");
			if (t.row < 0 || t.col < 0 || t.row_span < 1 || t.col_span < 1
				|| t.row + t.row_span > s.rows || t.col + t.col_span > s.cols)
				return fail("tile outside grid: " + t.camera);
			for (int r = t.row; r < t.row + t.row_span; ++r)
				for (int c = t.col; c < t.col + t.col_span; ++c) {
					char& u = used[static_cast<size_t>(r) * s.cols + c];
					if (u) return fail("overlapping tiles at " + std::to_string(r) + "," + std::to_string(c));
					u = 1;
				}
			const auto& k = t.crop;
			if (k.x < 0.f || k.y < 0.f || k.width <= 0.f || k.height <= 0.f
				|| k.x + k.width > 1.0001f || k.y + k.height > 1.0001f)
				return fail("crop outside frame: " + t.camera);
		}
		for (size_t i = 0; i < s.tiles.size(); ++i)
			for (size_t j = i + 1; j < s.tiles.size(); ++j) {
				const auto& a = s.tiles[i];
				const auto& b = s.tiles[j];
				if (a.camera == b.camera && a.crop == b.crop)
					return fail("duplicate tile: " + a.camera);
			}
		return true;
	}

	// Границы дорожек в пикселях по весам; последняя граница ровно size
	inline std::vector<int> track_edges(int size, int count, const std::vector<float>& fr) {
		std::vector<int> edges(count + 1, 0);
		float total = 0.f;
		for (int i = 0; i < count; ++i) total += fr.empty() ? 1.f : fr[i];
		float acc = 0.f;
		for (int i = 0; i < count; ++i) {
			acc += fr.empty() ? 1.f : fr[i];
			edges[i + 1] = static_cast<int>(std::lround(size * acc / total));
		}
		edges[count] = size;
		return edges;
	}

	// Ячейки тайлов на полотне без учёта источника
	inline std::vector<FTilePlacement> place_cells(const FVideoStream& s) {
		const auto xs = track_edges(s.width, s.cols, s.col_fr);
		const auto ys = track_edges(s.height, s.rows, s.row_fr);
		std::vector<FTilePlacement> out;
		out.reserve(s.tiles.size());
		for (const auto& t : s.tiles) {
			FTilePlacement p;
			p.camera = t.camera;
			p.crop = t.crop;
			const int x0 = xs[t.col], x1 = xs[t.col + t.col_span];
			const int y0 = ys[t.row], y1 = ys[t.row + t.row_span];
			p.cell = cv::Rect(x0, y0, x1 - x0, y1 - y0);
			p.dst = p.cell;
			out.push_back(std::move(p));
		}
		return out;
	}

	// Область картинки внутри ячейки для известного размера источника
	inline cv::Rect fit_rect(const cv::Rect& cell, const cv::Rect2f& crop, int cam_w, int cam_h, ETileFit fit) {
		if (fit == ETileFit::STRETCH || cam_w <= 0 || cam_h <= 0) return cell;
		const float src_w = crop.width * cam_w;
		const float src_h = crop.height * cam_h;
		if (src_w <= 0.f || src_h <= 0.f) return cell;
		const float scale = std::min(cell.width / src_w, cell.height / src_h);
		const int w = std::max(1, static_cast<int>(src_w * scale));
		const int h = std::max(1, static_cast<int>(src_h * scale));
		return cv::Rect(cell.x + (cell.width - w) / 2, cell.y + (cell.height - h) / 2, w, h);
	}

	// Рамка полотна - пиксели кадра камеры, с обрезкой по области тайла
	inline FDetection to_camera(const FTilePlacement& p, const FDetection& d) {
		FDetection out = d;
		const auto clampx = [&](int v) { return std::clamp(v, p.dst.x, p.dst.x + p.dst.width); };
		const auto clampy = [&](int v) { return std::clamp(v, p.dst.y, p.dst.y + p.dst.height); };
		const float sx = p.crop.width * p.cam_w / std::max(1, p.dst.width);
		const float sy = p.crop.height * p.cam_h / std::max(1, p.dst.height);
		const float ox = p.crop.x * p.cam_w;
		const float oy = p.crop.y * p.cam_h;
		out.x1_coord = static_cast<int>(std::lround(ox + (clampx(d.x1_coord) - p.dst.x) * sx));
		out.x2_coord = static_cast<int>(std::lround(ox + (clampx(d.x2_coord) - p.dst.x) * sx));
		out.y1_coord = static_cast<int>(std::lround(oy + (clampy(d.y1_coord) - p.dst.y) * sy));
		out.y2_coord = static_cast<int>(std::lround(oy + (clampy(d.y2_coord) - p.dst.y) * sy));
		return out;
	}

	// Рамка кадра камеры - пиксели полотна; за окном тайла рамка уходит за его край
	inline FDetection to_canvas(const FTilePlacement& p, const FDetection& d) {
		FDetection out = d;
		const float sx = p.dst.width / std::max(1.f, p.crop.width * p.cam_w);
		const float sy = p.dst.height / std::max(1.f, p.crop.height * p.cam_h);
		const float ox = p.crop.x * p.cam_w;
		const float oy = p.crop.y * p.cam_h;
		out.x1_coord = static_cast<int>(std::lround(p.dst.x + (d.x1_coord - ox) * sx));
		out.x2_coord = static_cast<int>(std::lround(p.dst.x + (d.x2_coord - ox) * sx));
		out.y1_coord = static_cast<int>(std::lround(p.dst.y + (d.y1_coord - oy) * sy));
		out.y2_coord = static_cast<int>(std::lround(p.dst.y + (d.y2_coord - oy) * sy));
		return out;
	}

	// Индекс тайла, которому принадлежит рамка: по центру внутри ячейки; -1 — пустая область
	inline int tile_of(const std::vector<FTilePlacement>& tiles, const FDetection& d) {
		const cv::Point c((d.x1_coord + d.x2_coord) / 2, (d.y1_coord + d.y2_coord) / 2);
		for (size_t i = 0; i < tiles.size(); ++i)
			if (tiles[i].state == ETileState::OK && tiles[i].cell.contains(c)) return static_cast<int>(i);
		return -1;
	}

	inline const char* fit_str(ETileFit f) { return f == ETileFit::STRETCH ? "stretch" : "letterbox"; }

	inline boost::json::object serialize_stream(const FVideoStream& s) {
		boost::json::object o;
		o["id"] = s.id;
		o["name"] = s.name;
		o["config_id"] = s.config_id;
		o["width"] = s.width;
		o["height"] = s.height;
		o["rows"] = s.rows;
		o["cols"] = s.cols;
		boost::json::array rf, cf;
		for (float f : s.row_fr) rf.emplace_back(static_cast<double>(f));
		for (float f : s.col_fr) cf.emplace_back(static_cast<double>(f));
		o["row_fr"] = std::move(rf);
		o["col_fr"] = std::move(cf);
		boost::json::array tiles;
		for (const auto& t : s.tiles) {
			boost::json::object to;
			to["camera"] = t.camera;
			to["row"] = t.row;
			to["col"] = t.col;
			to["row_span"] = t.row_span;
			to["col_span"] = t.col_span;
			boost::json::array crop;
			crop.emplace_back(static_cast<double>(t.crop.x));
			crop.emplace_back(static_cast<double>(t.crop.y));
			crop.emplace_back(static_cast<double>(t.crop.width));
			crop.emplace_back(static_cast<double>(t.crop.height));
			to["crop"] = std::move(crop);
			to["fit"] = fit_str(t.fit);
			tiles.push_back(std::move(to));
		}
		o["tiles"] = std::move(tiles);
		return o;
	}

	inline std::vector<float> parse_fr(const boost::json::value* v) {
		std::vector<float> out;
		if (!v || !v->is_array()) return out;
		for (const auto& x : v->as_array())
			if (x.is_number()) out.push_back(static_cast<float>(x.to_number<double>()));
		return out;
	}

	// Разбор объекта видеопотока; id можно передать снаружи (ключ объекта в streams.json)
	inline FVideoStream parse_stream(const boost::json::value& v, const std::string& id = {}) {
		FVideoStream s;
		s.id = id;
		if (!v.is_object()) return s;
		const auto& o = v.as_object();
		if (auto* x = o.if_contains("id"); x && x->is_string() && s.id.empty()) s.id = x->as_string().c_str();
		if (auto* x = o.if_contains("name"); x && x->is_string()) s.name = x->as_string().c_str();
		if (auto* x = o.if_contains("config_id"); x && x->is_string()) s.config_id = x->as_string().c_str();
		if (auto* x = o.if_contains("width"); x && x->is_int64()) s.width = (int)x->as_int64();
		if (auto* x = o.if_contains("height"); x && x->is_int64()) s.height = (int)x->as_int64();
		if (auto* x = o.if_contains("rows"); x && x->is_int64()) s.rows = (int)x->as_int64();
		if (auto* x = o.if_contains("cols"); x && x->is_int64()) s.cols = (int)x->as_int64();
		s.row_fr = parse_fr(o.if_contains("row_fr"));
		s.col_fr = parse_fr(o.if_contains("col_fr"));
		if (auto* ts = o.if_contains("tiles"); ts && ts->is_array()) {
			for (const auto& tv : ts->as_array()) {
				if (!tv.is_object()) continue;
				const auto& to = tv.as_object();
				FStreamTile t;
				if (auto* c = to.if_contains("camera"); c && c->is_string()) t.camera = c->as_string().c_str();
				if (auto* x = to.if_contains("row"); x && x->is_int64()) t.row = (int)x->as_int64();
				if (auto* x = to.if_contains("col"); x && x->is_int64()) t.col = (int)x->as_int64();
				if (auto* x = to.if_contains("row_span"); x && x->is_int64()) t.row_span = (int)x->as_int64();
				if (auto* x = to.if_contains("col_span"); x && x->is_int64()) t.col_span = (int)x->as_int64();
				if (auto* c = to.if_contains("crop"); c && c->is_array() && c->as_array().size() == 4) {
					const auto& a = c->as_array();
					float f[4];
					bool ok = true;
					for (int i = 0; i < 4; ++i) {
						if (!a[i].is_number()) { ok = false; break; }
						f[i] = static_cast<float>(a[i].to_number<double>());
					}
					if (ok) t.crop = cv::Rect2f(f[0], f[1], f[2], f[3]);
				}
				if (auto* f = to.if_contains("fit"); f && f->is_string() && std::string(f->as_string().c_str()) == "stretch")
					t.fit = ETileFit::STRETCH;
				s.tiles.push_back(std::move(t));
			}
		}
		return s;
	}

	// Поток «камера как есть»: один тайл на всё полотно
	inline FVideoStream stream_from_camera(const std::string& id, const std::string& config_id,
		const std::string& camera, int width, int height)
	{
		FVideoStream s;
		s.id = id;
		s.name = camera;
		s.config_id = config_id;
		s.width = width;
		s.height = height;
		FStreamTile t;
		t.camera = camera;
		s.tiles.push_back(std::move(t));
		return s;
	}

} // namespace neural
} // namespace varan
