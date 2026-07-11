// loader_state.json — новый формат:
//
// {
//     "config_id": "railway_camera",
//     "cameras": [
//         ["camera_1"]
//     ]
// }
//
// Или мозаика:
//
// {
//     "config_id": "railway_camera",
//     "cameras": [
//         ["camera_1", "camera_2"],
//         ["camera_3"]
//     ]
// }
//
// Семантика:
//   cameras[row][col] — камера в позиции (row, col) в мозаике.
//   Каждая строка может иметь свою длину.
//   Все камеры будут отресайзены под суммарную плитку, при этом
//   итоговая плитка отресайзится под model_w × model_h.
//
//   Пока поддерживается только [[single_camera]] — одна камера.
//   Многокамерный путь — заглушка для будущей реализации.


#pragma once

#include <string>
#include <vector>
#include <set>

namespace varan {
namespace neural {

	// Матрица камер. cameras[row][col].
	using FCameraMatrix = std::vector<std::vector<std::string>>;

	// Помощник: проверить, что матрица содержит ровно одну камеру (1×1).
	inline bool is_single_camera(const FCameraMatrix& m) {
		return m.size() == 1 && m[0].size() == 1 && !m[0][0].empty();
	}

	// Достать первую (единственную) камеру. Возвращает пустую строку если матрица невалидна.
	inline std::string first_camera(const FCameraMatrix& m) {
		if (m.empty() || m[0].empty()) return {};
		return m[0][0];
	}

	// Подсчёт всех уникальных камер в матрице.
	inline std::vector<std::string> flatten_cameras(const FCameraMatrix& m) {
		std::vector<std::string> result;
		for (const auto& row : m)
			for (const auto& c : row)
				if (!c.empty()) result.push_back(c);
		return result;
	}

	// Проверка валидности: все ряды непустые, все имена непустые,
	// нет дубликатов.
	inline bool is_valid_matrix(const FCameraMatrix& m, std::string* err = nullptr) {
		if (m.empty()) { if (err) *err = "matrix is empty"; return false; }
		std::set<std::string> seen;
		for (const auto& row : m) {
			if (row.empty()) { if (err) *err = "row is empty"; return false; }
			for (const auto& c : row) {
				if (c.empty()) { if (err) *err = "camera id is empty"; return false; }
				if (!seen.insert(c).second) {
					if (err) *err = "duplicate camera: " + c;
					return false;
				}
			}
		}
		return true;
	}

	// Богатая раскладка камер потока.
	//
	// Фронт редактирует и присылает занятые ячейки сетки (rows x cols, каждая
	// область — row/col/row_span/col_span). Бэкенд переводит их в нормализованные
	// тайлы [x, y, w, h] в долях кадра [0..1] — так рендеру сразу известно, где
	// отрисовывать каждую камеру. rows/cols сохраняются, чтобы редактор мог
	// восстановить ячейки из нормализованных координат.
	//
	// Сейчас конвейер обрабатывает только одну камеру (SINGLE — один тайл на весь
	// кадр). Многокамерная сетка хранится и валидируется, но её обработка — задел
	// на будущее (как мозаика в FCameraMatrix).
	enum class ECameraLayoutMode { SINGLE, GRID };

	struct FCameraTile {
		std::string camera;
		float x = 0.0f;   // левый край, доля ширины кадра
		float y = 0.0f;   // верхний край, доля высоты кадра
		float w = 1.0f;   // ширина, доля кадра
		float h = 1.0f;   // высота, доля кадра
	};

	struct FCameraLayout {
		ECameraLayoutMode mode = ECameraLayoutMode::SINGLE;
		int rows = 1;                     // размер сетки редактора
		int cols = 1;
		std::vector<FCameraTile> tiles;   // нормализованные тайлы камер
	};

	// Все камеры раскладки (для проверки уникальности и поиска по камере).
	inline std::vector<std::string> layout_cameras(const FCameraLayout& l) {
		std::vector<std::string> out;
		for (const auto& t : l.tiles)
			if (!t.camera.empty()) out.push_back(t.camera);
		return out;
	}

	// Первая камера раскладки — для текущего одно-камерного конвейера.
	inline std::string layout_first_camera(const FCameraLayout& l) {
		for (const auto& t : l.tiles)
			if (!t.camera.empty()) return t.camera;
		return {};
	}

	// Привести раскладку к матрице для существующего конвейера обработки.
	// Пока берём только первую камеру (SINGLE); сетка ещё не обрабатывается.
	inline FCameraMatrix layout_to_matrix(const FCameraLayout& l) {
		auto camera = layout_first_camera(l);
		if (camera.empty()) return {};
		return { { camera } };
	}

	// Валидность раскладки: есть хотя бы один тайл, у каждого непустая камера,
	// нет дубликатов камер.
	inline bool is_valid_layout(const FCameraLayout& l, std::string* err = nullptr) {
		if (l.tiles.empty()) { if (err) *err = "layout has no cameras"; return false; }
		std::set<std::string> seen;
		for (const auto& t : l.tiles) {
			if (t.camera.empty()) { if (err) *err = "empty camera in tile"; return false; }
			if (!seen.insert(t.camera).second) { if (err) *err = "duplicate camera: " + t.camera; return false; }
		}
		if (l.mode == ECameraLayoutMode::GRID && (l.rows < 1 || l.cols < 1)) {
			if (err) *err = "grid dimensions invalid";
			return false;
		}
		return true;
	}

} // namespace neural
} // namespace varan