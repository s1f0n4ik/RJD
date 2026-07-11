#pragma once

#include <boost/json.hpp>

#include "neural/matrix.h"

namespace varan {
namespace neural {

	// Сериализация раскладки в wire-формат: mode + rows/cols + нормализованные тайлы.
	// Рендеру достаточно "tiles": [{ camera, rect:[x,y,w,h] }] — доли кадра [0..1].
	// rows/cols нужны фронту, чтобы восстановить ячейки редактора.
	inline boost::json::object serialize_layout(const FCameraLayout& l) {
		boost::json::object o;
		o["mode"] = (l.mode == ECameraLayoutMode::GRID) ? "grid" : "single";
		o["rows"] = l.rows;
		o["cols"] = l.cols;
		if (l.mode == ECameraLayoutMode::SINGLE)
			o["single"] = layout_first_camera(l);

		boost::json::array tiles;
		for (const auto& t : l.tiles) {
			boost::json::object to;
			to["camera"] = t.camera;
			boost::json::array rect;
			rect.emplace_back(static_cast<double>(t.x));
			rect.emplace_back(static_cast<double>(t.y));
			rect.emplace_back(static_cast<double>(t.w));
			rect.emplace_back(static_cast<double>(t.h));
			to["rect"] = std::move(rect);
			tiles.push_back(std::move(to));
		}
		o["tiles"] = std::move(tiles);
		return o;
	}

	// Разбор wire-формата раскладки.
	// Приоритет источников:
	//   1) "tiles" — уже нормализованные (например, из state.json) — читаем как есть;
	//   2) mode == "grid" с "regions" (ячейки от фронта) — переводим в тайлы;
	//   3) "single" — одна камера на весь кадр.
	inline FCameraLayout parse_layout(const boost::json::value& v) {
		FCameraLayout l;
		if (!v.is_object()) return l;
		const auto& o = v.as_object();

		std::string mode = "single";
		if (auto* m = o.if_contains("mode"); m && m->is_string()) mode = m->as_string().c_str();
		if (auto* x = o.if_contains("rows"); x && x->is_int64()) l.rows = (int)x->as_int64();
		if (auto* x = o.if_contains("cols"); x && x->is_int64()) l.cols = (int)x->as_int64();

		if (auto* ts = o.if_contains("tiles"); ts && ts->is_array()) {
			l.mode = (mode == "grid") ? ECameraLayoutMode::GRID : ECameraLayoutMode::SINGLE;
			for (const auto& tv : ts->as_array()) {
				if (!tv.is_object()) continue;
				const auto& to = tv.as_object();
				FCameraTile t;
				if (auto* c = to.if_contains("camera"); c && c->is_string()) t.camera = c->as_string().c_str();
				if (auto* r = to.if_contains("rect"); r && r->is_array() && r->as_array().size() == 4) {
					const auto& a = r->as_array();
					if (a[0].is_number()) t.x = (float)a[0].to_number<double>();
					if (a[1].is_number()) t.y = (float)a[1].to_number<double>();
					if (a[2].is_number()) t.w = (float)a[2].to_number<double>();
					if (a[3].is_number()) t.h = (float)a[3].to_number<double>();
				}
				if (!t.camera.empty()) l.tiles.push_back(std::move(t));
			}
			return l;
		}

		if (mode == "grid") {
			l.mode = ECameraLayoutMode::GRID;
			if (l.rows < 1) l.rows = 1;
			if (l.cols < 1) l.cols = 1;
			if (auto* rs = o.if_contains("regions"); rs && rs->is_array()) {
				for (const auto& rv : rs->as_array()) {
					if (!rv.is_object()) continue;
					const auto& ro = rv.as_object();
					int row = 0, col = 0, row_span = 1, col_span = 1;
					std::string camera;
					if (auto* x = ro.if_contains("row"); x && x->is_int64()) row = (int)x->as_int64();
					if (auto* x = ro.if_contains("col"); x && x->is_int64()) col = (int)x->as_int64();
					if (auto* x = ro.if_contains("row_span"); x && x->is_int64()) row_span = (int)x->as_int64();
					if (auto* x = ro.if_contains("col_span"); x && x->is_int64()) col_span = (int)x->as_int64();
					if (auto* x = ro.if_contains("camera"); x && x->is_string()) camera = x->as_string().c_str();
					if (camera.empty()) continue;
					FCameraTile t;
					t.camera = camera;
					t.x = (float)col / (float)l.cols;
					t.y = (float)row / (float)l.rows;
					t.w = (float)col_span / (float)l.cols;
					t.h = (float)row_span / (float)l.rows;
					l.tiles.push_back(std::move(t));
				}
			}
			return l;
		}

		l.mode = ECameraLayoutMode::SINGLE;
		l.rows = 1;
		l.cols = 1;
		std::string cam;
		if (auto* x = o.if_contains("single"); x && x->is_string()) cam = x->as_string().c_str();
		if (!cam.empty()) l.tiles.push_back(FCameraTile{ cam, 0.0f, 0.0f, 1.0f, 1.0f });
		return l;
	}

	// Фоллбэк со старого формата camera_matrix: первая камера как SINGLE-раскладка.
	inline FCameraLayout layout_from_matrix(const FCameraMatrix& m) {
		FCameraLayout l;
		l.mode = ECameraLayoutMode::SINGLE;
		l.rows = 1;
		l.cols = 1;
		auto cam = first_camera(m);
		if (!cam.empty()) l.tiles.push_back(FCameraTile{ cam, 0.0f, 0.0f, 1.0f, 1.0f });
		return l;
	}

} // namespace neural
} // namespace varan
