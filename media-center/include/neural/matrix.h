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

	} // namespace neural
} // namespace varan