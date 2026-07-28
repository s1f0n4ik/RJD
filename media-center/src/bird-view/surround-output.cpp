#include "bird-view/surround-output.h"
#include "core/paths.h"
#include "bird-view/surround-bake.h"
#include "bird-view/surround-model.h"
#include "bird-view/constants.h"

#include "calibration/constants.h"

namespace calib_consts = varan::calibration::constants;

namespace varan {
namespace birdview {

	USurroundOutput::USurroundOutput(
		UEGLContextManager* context,
		ULinkerStore* store,
		std::string export_id,
		NCamerasPurpose bindings,
		std::atomic<unsigned>* dirty,
		std::atomic<int>* orbit_mode_request,
		CPosesPublish publish_poses,
		ULogger* logger)
		: m_context(context)
		, m_store(store)
		, m_export_id(std::move(export_id))
		, m_bindings(std::move(bindings))
		, m_dirty(dirty)
		, m_orbit_mode_request(orbit_mode_request)
		, m_publish_poses(std::move(publish_poses))
		, m_logger(logger)
	{
	}

	void USurroundOutput::apply_visuals(const boost::json::object& cfg) {
		boost::json::object orbit, model;
		if (auto* v = js::obj(cfg, "orbit")) orbit = *v;
		if (auto* v = js::obj(cfg, "model")) model = *v;

		m_renderer.set_orbit(
			static_cast<float>(js::num(orbit, "distance", 3.4)),
			static_cast<float>(js::num(orbit, "height", 2.0)),
			static_cast<float>(js::num(orbit, "speed", 0.25)));
		m_renderer.set_model(
			static_cast<float>(js::num(model, "width", 0.0)),
			static_cast<float>(js::num(model, "height", 0.0)),
			static_cast<float>(js::num(model, "length", 0.0)),
			static_cast<float>(js::num(model, "alpha", 1.0)));
		m_renderer.set_model_rotation(static_cast<float>(js::num(model, "rotation", 0.0)));
		m_renderer.set_plate(js::flag(cfg, "plate", true));
		m_renderer.set_plate_size(
			static_cast<float>(js::num(cfg, "plate_width", 0.0)),
			static_cast<float>(js::num(cfg, "plate_length", 0.0)));
		m_renderer.set_wireframe(js::flag(cfg, "wireframe", false));
		m_renderer.set_photometric_enabled(js::flag(cfg, "photometric", true));

		// Смена файла модели: перезагрузка прямо в потоке рендера,
		// запинка на кадр допустима так же, как у перепечки
		const std::string source = js::str(model, "source");
		if (source != m_loaded_model_source) {
			if (source.empty()) {
				m_renderer.clear_model_mesh();
			}
			else {
				FSurroundModel mesh;
				std::string model_error;
				if (load_surround_model(varan::paths().surround.presets_models / source, mesh, model_error)
					&& m_renderer.set_model_mesh(mesh)) {
					if (m_logger) m_logger->info("apply_visuals(): model <" + source + "> loaded");
				}
				else {
					if (m_logger) m_logger->error("apply_visuals(): model <" + source
						+ "> failed: " + model_error + ", box fallback");
					m_renderer.clear_model_mesh();
				}
			}
			m_loaded_model_source = source;
		}
	}

	bool USurroundOutput::apply_bake(const boost::json::object& cfg) {
		USurroundBaker baker(m_logger);
		FSurroundMachine machine;
		FSurroundBake bake;
		std::string bake_error;

		// Действующий габарит: пресет конфигуратора, рект первой картинки
		// как запасной, пользовательские правки панели поверх
		boost::json::object effective_cfg = cfg;
		{
			boost::json::object machine_obj;
			if (auto entry = m_store->read_export_entry(m_export_id)) {
				if (auto* m = js::obj(*entry, "machine")) machine_obj = *m;
				if (!machine_obj.contains("rect")) {
					if (auto* imgs = js::arr(*entry, "images"); imgs && !imgs->empty()
						&& imgs->front().is_object()) {
						if (auto* r = imgs->front().as_object().if_contains("rect")) {
							machine_obj["rect"] = *r;
						}
					}
				}
			}
			if (auto* um = js::obj(cfg, "machine")) {
				for (const auto& kv : *um) machine_obj[kv.key()] = kv.value();
			}
			effective_cfg["machine"] = std::move(machine_obj);
		}

		bool ok = USurroundBaker::parse_machine(effective_cfg, machine, bake_error);
		if (ok) {
			m_renderer.set_bowl_factors(machine.bowl_floor, machine.bowl_outer,
				machine.bowl_wall, machine.bowl_plate, machine.bowl_corner);
			m_renderer.set_machine(machine.width, machine.height, machine.length);
			ok = baker.bake(
				effective_cfg,
				varan::paths().surround.presets_json,
				varan::paths().surround.calibration_settings,
				m_bindings, m_renderer.bowl_positions(), bake, bake_error);
		}

		if (!ok || !m_renderer.set_camera_attributes(bake.camera_attributes)) {
			if (m_logger) m_logger->error("apply_bake(): bake failed: "
				+ bake_error + ", grid only");
			return false;
		}

		m_renderer.set_photometric_pairs(bake.photo_pairs);

		m_camera_keys.clear();
		for (const auto& cam : bake.cameras) m_camera_keys.push_back(cam.place_key);
		if (m_publish_poses) m_publish_poses(std::move(bake.cameras));
		return true;
	}

	bool USurroundOutput::prepare(int& out_width, int& out_height, std::string& error) {
		if (!m_renderer.init(0, m_context, m_logger)) {
			error = "surround renderer init failed";
			return false;
		}

		out_width = constants::SURROUND_WIDTH;
		out_height = constants::SURROUND_HEIGHT;

		// Без surround-блока в экспорте остаётся сетка первого блока
		bool interactive = false;
		if (auto cfg = m_store->read_surround_cfg(m_export_id)) {
			apply_visuals(*cfg);
			apply_bake(*cfg);

			// Стартовый режим орбиты, дальше его меняют тумблер и кнопка плеера
			if (auto* o = js::obj(*cfg, "orbit")) {
				interactive = js::flag(*o, "interactive", false);
			}

			// Разрешение из конфигурации; кламп на случай ручной правки файла
			if (auto* r = js::obj(*cfg, "resolution")) {
				out_width = clamp_frame_side(
					js::num(*r, "width", out_width), SURROUND_RES_MIN, SURROUND_RES_MAX_W);
				out_height = clamp_frame_side(
					js::num(*r, "height", out_height), SURROUND_RES_MIN, SURROUND_RES_MAX_H);
			}
		}
		else {
			if (m_logger) m_logger->info("USurroundOutput::prepare(): "
				"no surround block in export, grid only");
		}
		m_renderer.set_orbit_mode(interactive);
		if (m_dirty) m_dirty->store(0);
		if (m_orbit_mode_request) m_orbit_mode_request->store(-1);

		m_out_w = out_width;
		m_out_h = out_height;
		m_renderer.set_output_size(out_width, out_height);

		if (m_logger) m_logger->info("USurroundOutput::prepare(): out="
			+ std::to_string(out_width) + "x" + std::to_string(out_height));
		return true;
	}

	bool USurroundOutput::apply_live_changes() {
		bool keys_changed = false;

		// Живые изменения ручки: лёгкие - сеттеры, тяжёлые - перепечка
		if (const unsigned dirty = m_dirty ? m_dirty->exchange(0) : 0) {
			if (auto cfg = m_store->read_surround_cfg(m_export_id)) {
				apply_visuals(*cfg);
				if (dirty & SURROUND_DIRTY_BAKE) {
					keys_changed = apply_bake(*cfg);
				}
			}
		}

		if (m_orbit_mode_request) {
			if (const int req = m_orbit_mode_request->exchange(-1); req >= 0) {
				m_renderer.set_orbit_mode(req == 1);
			}
		}
		return keys_changed;
	}

	void USurroundOutput::bind_camera(USurroundCamera& camera) {
		// Режим переживает стример: общий цикл гасит камеру раньше рендерера
		camera.set_orbit_callbacks(
			[this](bool manual) { m_renderer.set_orbit_mode(manual); },
			[this](float dx, float dy, float dzoom) {
				m_renderer.apply_orbit_input(dx, dy, dzoom);
			});
	}

	void USurroundOutput::render_frame(std::vector<NPFrame>& frames, float dt, EGLDisplay display) {
		m_renderer.update_textures(frames, display);
		m_renderer.update(dt);
		m_renderer.render(static_cast<float>(m_out_w) / static_cast<float>(m_out_h));
	}

} // birdview
} // varan
