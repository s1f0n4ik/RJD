#include "bird-view/surround-bake.h"
#include "calibration/json-projection.h"
#include "calibration/constants.h"

#include <algorithm>
#include <fstream>
#include <sstream>
#include <cmath>

namespace varan {
namespace birdview {

	namespace {

		// Обратный разбор make_json_object_mat, плюс плоский массив чисел
		// При расхождении rows*cols с длиной data верим data: писатель молчит
		// про многоканальные матрицы, и форма в файле бывает кривой
		bool parse_mat(const boost::json::value& v, cv::Mat& out) {
			const boost::json::array* arr = nullptr;
			int r = 0, c = 1;

			if (v.is_array()) {
				arr = &v.as_array();
				r = static_cast<int>(arr->size());
			}
			else if (v.is_object()) {
				const auto& obj = v.as_object();
				const auto* data = obj.if_contains("data");
				if (!data || !data->is_array()) return false;
				arr = &data->as_array();

				const auto* rows = obj.if_contains("rows");
				const auto* cols = obj.if_contains("cols");
				r = rows ? static_cast<int>(rows->to_number<int64_t>()) : 0;
				c = cols ? static_cast<int>(cols->to_number<int64_t>()) : 1;
				if (r <= 0 || c <= 0 || arr->size() != static_cast<size_t>(r) * c) {
					r = static_cast<int>(arr->size());
					c = 1;
				}
			}
			else {
				return false;
			}

			if (!arr || arr->empty()) return false;

			out.create(r, c, CV_64F);
			for (size_t i = 0; i < arr->size(); ++i) {
				out.at<double>(static_cast<int>(i) / c, static_cast<int>(i) % c)
					= (*arr)[i].to_number<double>();
			}
			return true;
		}

		struct FCalibEntry {
			cv::Mat K, D, new_K;
			cv::Size image_size;
		};

		// Запись калибровки камеры: по явному ключу или первая с совпавшим id
		bool find_calibration(
			const boost::json::object& root,
			const std::string& camera_id,
			const std::string& explicit_key,
			FCalibEntry& out,
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

			const auto* km = entry->if_contains("camera_matrix");
			const auto* dm = entry->if_contains("distortion_coeffs");
			const auto* nk = entry->if_contains("new_K");
			const auto* w = entry->if_contains("width");
			const auto* h = entry->if_contains("height");

			if (!km || !parse_mat(*km, out.K) || out.K.total() != 9) {
				error = "camera <" + camera_id + ">: bad camera_matrix";
				return false;
			}
			if (out.K.rows != 3) out.K = out.K.reshape(1, 3);
			if (!dm || !parse_mat(*dm, out.D)) {
				error = "camera <" + camera_id + ">: bad distortion_coeffs";
				return false;
			}
			// fisheye ждёт ровно четыре коэффициента столбцом
			out.D = out.D.reshape(1, static_cast<int>(out.D.total()));
			if (out.D.rows > 4) out.D = out.D.rowRange(0, 4).clone();
			// new_K может отсутствовать, тогда точки считаются в исходной K
			if (nk) {
				parse_mat(*nk, out.new_K);
				if (out.new_K.total() == 9 && out.new_K.rows != 3) out.new_K = out.new_K.reshape(1, 3);
			}
			if (out.new_K.empty()) out.new_K = out.K.clone();

			if (!w || !h) {
				error = "camera <" + camera_id + ">: missing frame size";
				return false;
			}
			out.image_size = {
				static_cast<int>(w->to_number<int64_t>()),
				static_cast<int>(h->to_number<int64_t>())
			};
			return true;
		}

	} // namespace

	bool USurroundBaker::parse_machine(
		const boost::json::object& surround_cfg,
		FSurroundMachine& out,
		std::string& error)
	{
		const auto* machine = surround_cfg.if_contains("machine");
		if (!machine || !machine->is_object()) {
			error = "surround config: missing machine block";
			return false;
		}
		const auto& m = machine->as_object();
		const auto* len = m.if_contains("length");
		const auto* wid = m.if_contains("width");
		const auto* hei = m.if_contains("height");
		const auto* rect = m.if_contains("rect");
		if (!len || !wid || !hei || !rect || !rect->is_array() || rect->as_array().size() != 4) {
			error = "surround config: machine needs length, width, height, rect[4]";
			return false;
		}
		out.length = static_cast<float>(len->to_number<double>());
		out.width = static_cast<float>(wid->to_number<double>());
		out.height = static_cast<float>(hei->to_number<double>());
		const auto& r = rect->as_array();
		out.canvas_rect = {
			static_cast<float>(r[0].to_number<double>()),
			static_cast<float>(r[1].to_number<double>()),
			static_cast<float>(r[2].to_number<double>()),
			static_cast<float>(r[3].to_number<double>())
		};
		if (out.length <= 0 || out.canvas_rect.height <= 0) {
			error = "surround config: non-positive machine size";
			return false;
		}

		// Мат из конфигуратора, необязательный
		if (auto* v = m.if_contains("mat_m"); v && v->is_number()) {
			out.mat_m = static_cast<float>(v->to_number<double>());
		}
		if (auto* v = m.if_contains("mat_px"); v && v->is_number()) {
			out.mat_px = static_cast<float>(v->to_number<double>());
		}

		// Необязательные пропорции чаши, без блока остаются значения по умолчанию
		if (auto* b = surround_cfg.if_contains("bowl"); b && b->is_object()) {
			const auto& obj = b->as_object();
			auto pick = [&](const char* key, float& dst) {
				if (auto* v = obj.if_contains(key); v && v->is_number()) {
					const float f = static_cast<float>(v->to_number<double>());
					if (f > 0) dst = f;
				}
			};
			pick("floor", out.bowl_floor);
			pick("wall", out.bowl_wall);
			pick("plate", out.bowl_plate);
			pick("blend", out.bowl_blend);
			// Ноль допустим: вертикальная стенка и прямые углы
			auto pick_zero = [&](const char* key, float& dst) {
				if (auto* v = obj.if_contains(key); v && v->is_number()) {
					const float f = static_cast<float>(v->to_number<double>());
					if (f >= 0) dst = f;
				}
			};
			pick_zero("outer", out.bowl_outer);
			pick_zero("corner", out.bowl_corner);
		}
		return true;
	}

	bool USurroundBaker::bake(
		const boost::json::object& surround_cfg,
		const std::filesystem::path& presets_path,
		const std::filesystem::path& calibration_path,
		const std::unordered_map<std::string, std::optional<std::string>>& bindings,
		const std::vector<glm::vec3>& vertices,
		FSurroundBake& out,
		std::string& error)
	{
		if (!parse_machine(surround_cfg, out.machine, error)) return false;

		std::string preset_key;
		if (auto* v = surround_cfg.if_contains("preset"); v && v->is_string()) {
			preset_key = v->as_string().c_str();
		}
		else {
			error = "surround config: missing preset key";
			return false;
		}

		// Пресет конфигуратора: там лежат пары точек разметки
		calibration::UJsonProjectionConfiguration presets(m_logger);
		if (!presets.read(presets_path.string())) {
			error = "cannot read presets at " + presets_path.string();
			return false;
		}
		auto preset = presets.load_preset(preset_key);
		if (!preset) {
			error = "preset <" + preset_key + "> not found";
			return false;
		}

		boost::json::object calib_root;
		{
			std::ifstream f(calibration_path);
			if (!f) {
				error = "cannot read calibration at " + calibration_path.string();
				return false;
			}
			std::stringstream ss; ss << f.rdbuf();
			auto v = boost::json::parse(ss.str());
			if (!v.is_object()) {
				error = "calibration file is not an object";
				return false;
			}
			calib_root = v.as_object();
		}

		// Необязательная карта camera_id -> ключ записи калибровки
		boost::json::object calib_keys;
		if (auto* v = surround_cfg.if_contains("calibration"); v && v->is_object()) {
			calib_keys = v->as_object();
		}

		// Канвас в метры: мат мерян рулеткой и точнее ректа на глаз;
		// без мата масштаб по длине машины, начало всегда в её центре
		const float scale = (out.machine.mat_m > 0 && out.machine.mat_px > 0)
			? out.machine.mat_m / out.machine.mat_px
			: out.machine.length / out.machine.canvas_rect.height;
		const float cx = out.machine.canvas_rect.x + out.machine.canvas_rect.width * 0.5f;
		const float cy = out.machine.canvas_rect.y + out.machine.canvas_rect.height * 0.5f;

		struct FPose {
			std::string place_key;
			cv::Mat R, t, K, D;
			cv::Size image_size;
			// Центроид canvas_region камеры в метрах на плоскости, x и z мира
			cv::Point2d region;
		};
		std::vector<FPose> poses;

		// Ручные оверрайды extrinsics по местам, пишутся curl-ручкой
		boost::json::object overrides;
		if (auto* v = surround_cfg.if_contains("extrinsics"); v && v->is_object()) {
			overrides = v->as_object();
		}

		for (const auto& [place_key, cam] : preset->cameras) {
			auto bind = bindings.find(place_key);
			if (bind == bindings.end() || !bind->second.has_value()) continue;
			const std::string camera_id = *bind->second;

			if (cam.src_points.size() < 4 || cam.src_points.size() != cam.dst_points.size()) {
				if (m_logger) m_logger->warn("bake(): <" + place_key + "> has "
					+ std::to_string(cam.src_points.size()) + " points, need 4+, skipped");
				continue;
			}

			std::string explicit_key;
			if (auto* v = calib_keys.if_contains(camera_id); v && v->is_string()) {
				explicit_key = v->as_string().c_str();
			}

			FCalibEntry calib;
			if (!find_calibration(calib_root, camera_id, explicit_key, calib, error)) {
				return false;
			}

			// Точки разметки: src нормированы на исправленном кадре, dst на канвасе
			std::vector<cv::Point2f> image_points;
			std::vector<cv::Point3f> object_points;
			for (size_t i = 0; i < cam.src_points.size(); ++i) {
				image_points.emplace_back(
					cam.src_points[i].x * calib.image_size.width,
					cam.src_points[i].y * calib.image_size.height);
				object_points.emplace_back(
					(cam.dst_points[i].x - cx) * scale,
					0.0f,
					(cam.dst_points[i].y - cy) * scale);
			}

			cv::Mat R, tvec;
			double reproj = 0.0, height = 0.0;

			const auto* ov = overrides.if_contains(place_key);
			if (ov && ov->is_object()) {
				// Ручная поза вместо PnP: позиция в метрах от центра габарита,
				// yaw 0 - взгляд вдоль +Z, положительный pitch - вниз
				const auto& o = ov->as_object();
				const auto* posv = o.if_contains("position");
				if (!posv || !posv->is_array() || posv->as_array().size() != 3) {
					error = "extrinsics <" + place_key + ">: position must be [x,y,z]";
					return false;
				}
				const auto& pa = posv->as_array();
				const double px = pa[0].to_number<double>();
				const double py = pa[1].to_number<double>();
				const double pz = pa[2].to_number<double>();
				auto ang = [&](const char* k) {
					auto* v = o.if_contains(k);
					return v ? v->to_number<double>() * CV_PI / 180.0 : 0.0;
				};
				const double yaw = ang("yaw"), pitch = ang("pitch"), roll = ang("roll");

				cv::Vec3d fwd(std::sin(yaw) * std::cos(pitch), -std::sin(pitch),
					std::cos(yaw) * std::cos(pitch));
				cv::Vec3d up(0, 1, 0);
				cv::Vec3d right = fwd.cross(up);
				if (cv::norm(right) < 1e-6) right = cv::Vec3d(-1, 0, 0);
				right = right / cv::norm(right);
				cv::Vec3d down = fwd.cross(right);
				// Крен вокруг оси взгляда
				cv::Mat roll_rot;
				cv::Rodrigues(cv::Mat(cv::Vec3d(fwd * roll)), roll_rot);
				cv::Mat right_m = roll_rot * cv::Mat(right);
				cv::Mat down_m = roll_rot * cv::Mat(down);

				cv::Mat R_cw(3, 3, CV_64F);
				for (int i = 0; i < 3; ++i) {
					R_cw.at<double>(i, 0) = right_m.at<double>(i);
					R_cw.at<double>(i, 1) = down_m.at<double>(i);
					R_cw.at<double>(i, 2) = fwd[i];
				}
				R = R_cw.t();
				cv::Mat C = (cv::Mat_<double>(3, 1) << px, py, pz);
				tvec = -R * C;
				height = py;

				if (m_logger) m_logger->info("bake(): <" + place_key + "> camera=" + camera_id
					+ " manual extrinsics, height=" + std::to_string(height) + " m");
			}
			else {
				// Поза по плоским точкам: точки в исправленном кадре, дисторсия нулевая
				cv::Mat rvec;
				if (!cv::solvePnP(object_points, image_points, calib.new_K, cv::Mat(),
					rvec, tvec, false, cv::SOLVEPNP_IPPE)) {
					error = "solvePnP failed for <" + place_key + ">";
					return false;
				}
				cv::Rodrigues(rvec, R);

				// Позиция камеры в мире, высота — мгновенная проверка позы глазами
				cv::Mat C = -R.t() * tvec;
				height = C.at<double>(1);

				std::vector<cv::Point2f> reprojected;
				cv::projectPoints(object_points, rvec, tvec, calib.new_K, cv::Mat(), reprojected);
				double err_sum = 0.0;
				for (size_t i = 0; i < reprojected.size(); ++i) {
					err_sum += cv::norm(reprojected[i] - image_points[i]);
				}
				reproj = err_sum / reprojected.size();

				if (m_logger) m_logger->info("bake(): <" + place_key + "> camera=" + camera_id
					+ " reproj=" + std::to_string(reproj) + " px"
					+ " height=" + std::to_string(height) + " m");
			}

			// Центр зоны камеры: центроид её региона на канвасе,
			// без региона - центр рамки её точек
			double rcx = 0.0, rcy = 0.0;
			const auto& poly = cam.canvas_region.empty() ? cam.dst_points : cam.canvas_region;
			for (const auto& p : poly) { rcx += p.x; rcy += p.y; }
			rcx /= poly.size(); rcy /= poly.size();

			FPose pose;
			pose.place_key = place_key;
			pose.R = R;
			pose.t = tvec;
			// Сырой кадр - круг 180 градусов: fisheye с исходной K и
			// пользовательскими коэффициентами дисторсии
			pose.K = calib.K;
			pose.D = calib.D;
			pose.image_size = calib.image_size;
			pose.region = { (rcx - cx) * scale, (rcy - cy) * scale };
			poses.push_back(std::move(pose));

			// Действующая поза для формы: позиция из C, углы обратно из R
			FSurroundBakedCamera baked;
			baked.place_key = place_key;
			baked.camera_id = camera_id;
			baked.reprojection_error = reproj;
			baked.camera_height = height;
			baked.manual = ov && ov->is_object();
			{
				cv::Mat C = -R.t() * tvec;
				for (int i = 0; i < 3; ++i) baked.position[i] = C.at<double>(i);

				const cv::Vec3d fwd(R.at<double>(2, 0), R.at<double>(2, 1), R.at<double>(2, 2));
				baked.yaw = std::atan2(fwd[0], fwd[2]) * 180.0 / CV_PI;
				baked.pitch = std::asin(std::clamp(-fwd[1], -1.0, 1.0)) * 180.0 / CV_PI;

				// Крен: отклонение реального "право" от безкренового базиса
				cv::Vec3d right0 = fwd.cross(cv::Vec3d(0, 1, 0));
				if (cv::norm(right0) < 1e-6) right0 = cv::Vec3d(-1, 0, 0);
				right0 = right0 / cv::norm(right0);
				const cv::Vec3d down0 = fwd.cross(right0);
				const cv::Vec3d right(R.at<double>(0, 0), R.at<double>(0, 1), R.at<double>(0, 2));
				baked.roll = std::atan2(right.dot(down0), right.dot(right0)) * 180.0 / CV_PI;
			}
			out.cameras.push_back(std::move(baked));
		}

		if (poses.empty()) {
			error = "no cameras with points and bindings";
			return false;
		}

		// Печка: каждая вершина проецируется в сырой кадр каждой камеры
		out.camera_attributes.assign(poses.size(),
			std::vector<float>(vertices.size() * SURROUND_ATTR_STRIDE, 0.0f));

		// Обращение fisheye r(theta) Ньютоном: угол луча по радиусу от центра
		auto theta_from_r = [](double r_px, const cv::Mat& K, const cv::Mat& D) {
			const double f = (K.at<double>(0, 0) + K.at<double>(1, 1)) * 0.5;
			const double k1 = D.at<double>(0), k2 = D.at<double>(1);
			const double k3 = D.at<double>(2), k4 = D.at<double>(3);
			double theta = r_px / f;
			for (int i = 0; i < 10; ++i) {
				const double t2 = theta * theta;
				const double poly = theta * (1 + t2 * (k1 + t2 * (k2 + t2 * (k3 + t2 * k4))));
				const double deriv = 1 + t2 * (3 * k1 + t2 * (5 * k2 + t2 * (7 * k3 + 9 * t2 * k4)));
				theta -= (poly - r_px / f) / std::max(deriv, 1e-6);
			}
			return theta;
		};

		const double machine_side = std::min(out.machine.width, out.machine.length);
		const double blend = std::max(1e-3, static_cast<double>(out.machine.bowl_blend) * machine_side);

		for (size_t ci = 0; ci < poses.size(); ++ci) {
			const auto& pose = poses[ci];

			// Предел угла объектива: за ним fisheye-полином заворачивает и
			// проецирует точки вне поля зрения обратно внутрь кадра
			const double pcx = pose.K.at<double>(0, 2);
			const double pcy = pose.K.at<double>(1, 2);
			const double r_max = std::sqrt(
				std::pow(std::max(pcx, pose.image_size.width - pcx), 2.0) +
				std::pow(std::max(pcy, pose.image_size.height - pcy), 2.0));
			double theta_max = theta_from_r(r_max, pose.K, pose.D) * 1.02;

			// Полином может потерять монотонность раньше угла кадра
			{
				const double k1 = pose.D.at<double>(0), k2 = pose.D.at<double>(1);
				const double k3 = pose.D.at<double>(2), k4 = pose.D.at<double>(3);
				for (double th = 0.05; th < theta_max; th += 0.01) {
					const double t2 = th * th;
					const double deriv = 1 + t2 * (3 * k1 + t2 * (5 * k2 + t2 * (7 * k3 + 9 * t2 * k4)));
					if (deriv <= 0) { theta_max = th * 0.98; break; }
				}
			}

			// Порог "перед камерой" от масштаба сцены, не в абсолютных метрах
			const double near_eps = std::max(out.machine.width, out.machine.length) * 0.02;

			const double f_avg = (pose.K.at<double>(0, 0) + pose.K.at<double>(1, 1)) * 0.5;
			const float W = static_cast<float>(pose.image_size.width);
			const float H = static_cast<float>(pose.image_size.height);

			// Вес вершины по Вороному: расстояние до центроида этой камеры
			// против ближайшего из остальных, переход шириной blend у границы
			auto sector_weight = [&](const glm::vec3& p) {
				auto dist = [&](const cv::Point2d& c) {
					return std::hypot(p.x - c.x, p.z - c.y);
				};
				const double d_own = dist(pose.region);
				double d_other = 1e9;
				for (size_t j = 0; j < poses.size(); ++j) {
					if (j == ci) continue;
					d_other = std::min(d_other, dist(poses[j].region));
				}
				if (d_other > 1e8) return 1.0f;
				const double margin = (d_other - d_own) / blend + 0.5;
				return static_cast<float>(std::clamp(margin, 0.0, 1.0));
			};

			std::vector<cv::Point3f> in_front;
			std::vector<size_t> front_index;
			in_front.reserve(vertices.size());
			for (size_t vi = 0; vi < vertices.size(); ++vi) {
				const auto& p = vertices[vi];
				cv::Mat pw = (cv::Mat_<double>(3, 1) << p.x, p.y, p.z);
				cv::Mat pc = pose.R * pw + pose.t;
				const double x = pc.at<double>(0);
				const double y = pc.at<double>(1);
				const double z = pc.at<double>(2);
				const double rho = std::hypot(x, y);
				const double theta = std::atan2(rho, z);

				float* attr = out.camera_attributes[ci].data() + vi * SURROUND_ATTR_STRIDE;
				attr[2] = sector_weight(p);

				if (z > near_eps && theta <= theta_max) {
					in_front.emplace_back(
						static_cast<float>(x), static_cast<float>(y), static_cast<float>(z));
					front_index.push_back(vi);
					continue;
				}

				const double dx = rho > 1e-9 ? x / rho : 1.0;
				const double dy = rho > 1e-9 ? y / rho : 0.0;
				// Достройка от радиуса угла кадра: всегда вне кадра, без прыжка
				// внутрь на стыке с точной моделью
				const double r = r_max * 1.02 + f_avg * std::max(0.0, theta - theta_max);
				attr[0] = static_cast<float>((pcx + r * dx) / W);
				attr[1] = static_cast<float>((pcy + r * dy) / H);
			}
			if (in_front.empty()) continue;

			// Дисторсия входит в проекцию, чаша сэмплирует сырой круг напрямую
			std::vector<cv::Point2f> projected;
			cv::fisheye::projectPoints(in_front, projected,
				cv::Mat::zeros(3, 1, CV_64F), cv::Mat::zeros(3, 1, CV_64F),
				pose.K, pose.D);

			for (size_t k = 0; k < projected.size(); ++k) {
				const auto& px = projected[k];
				float* attr = out.camera_attributes[ci].data()
					+ front_index[k] * SURROUND_ATTR_STRIDE;
				attr[0] = px.x / W;
				attr[1] = px.y / H;
			}
		}

		// Точки фотонормализации: вершины в клине смешивания пары, где обе
		// камеры видят землю честным UV внутри кадра
		for (size_t a = 0; a < poses.size(); ++a) {
			for (size_t b = a + 1; b < poses.size(); ++b) {
				auto in_blend = [&](size_t cam, size_t vi, float& u, float& v) {
					const float* attr = out.camera_attributes[cam].data()
						+ vi * SURROUND_ATTR_STRIDE;
					u = attr[0]; v = attr[1];
					const float w = attr[2];
					return w > 0.02f && w < 0.98f
						&& u > 0.02f && u < 0.98f && v > 0.02f && v < 0.98f;
				};

				std::vector<std::array<float, 4>> found;
				for (size_t vi = 0; vi < vertices.size(); ++vi) {
					float ua, va, ub, vb;
					if (in_blend(a, vi, ua, va) && in_blend(b, vi, ub, vb)) {
						found.push_back({ ua, va, ub, vb });
					}
				}
				if (found.size() < 16) continue;

				FSurroundPhotoPair pair;
				pair.cam_a = static_cast<int>(a);
				pair.cam_b = static_cast<int>(b);
				const size_t stride = std::max<size_t>(1, found.size() / SURROUND_PHOTO_SAMPLES);
				for (size_t k = 0; k < found.size(); k += stride) {
					if (pair.uv.size() >= SURROUND_PHOTO_SAMPLES) break;
					pair.uv.push_back(found[k]);
				}
				out.photo_pairs.push_back(std::move(pair));
			}
		}

		if (m_logger) m_logger->info("bake(): photometric pairs=" + std::to_string(out.photo_pairs.size()));

		return true;
	}

} // birdview
} // varan
