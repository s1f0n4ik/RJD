#include "bird-view/top-output.h"
#include "core/paths.h"
#include "bird-view/top-bake.h"
#include "bird-view/surround-output.h"
#include "bird-view/surround-model.h"
#include "bird-view/constants.h"
#include "bird-view/utility.h"

#include "utility/gl-maps.h"

#include <unordered_map>

namespace varan {
namespace birdview {

	UTopOutput::UTopOutput(
		UEGLContextManager* context,
		ULinkerStore* store,
		std::string export_id,
		int rotation_degrees,
		std::atomic<unsigned>* dirty,
		ULogger* logger)
		: m_context(context)
		, m_store(store)
		, m_export_id(std::move(export_id))
		, m_rotation_degrees(rotation_degrees)
		, m_dirty(dirty)
		, m_logger(logger)
	{
	}

	void UTopOutput::apply_visuals(const boost::json::object& cfg) {
		boost::json::object model;
		if (auto* v = js::obj(cfg, "model")) model = *v;

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
		m_renderer.set_photometric_enabled(js::flag(cfg, "photometric", true));

		// Правки рисунков: показ и размер; без записи - исходный вид
		std::unordered_map<std::string, UStitchRenderer::FOverlayOverride> overlay_ov;
		if (auto* imgs = js::obj(cfg, "images")) {
			for (const auto& kv : *imgs) {
				if (!kv.value().is_object()) continue;
				const auto& io = kv.value().as_object();
				UStitchRenderer::FOverlayOverride o;
				o.visible = js::flag(io, "visible", true);
				o.width = static_cast<int>(js::num(io, "width", 0));
				o.height = static_cast<int>(js::num(io, "height", 0));
				overlay_ov[std::string(kv.key())] = o;
			}
		}
		m_renderer.set_overlay_overrides(overlay_ov);

		/*
			Сцена привязана к зоне габарита: рект из machine-блока записи,
			запасной - рект первой картинки. Метры мира оттуда же; масштаб
			по мату точнее ректа на глаз. Совсем без метров сцена живёт в
			пикселях: модель всё равно вписывается в рект пропорционально.
		*/
		boost::json::object machine;
		cv::Rect2f rect{ 0, 0, 0, 0 };
		if (auto entry = m_store->read_export_entry(m_export_id)) {
			if (auto* m = js::obj(*entry, "machine")) machine = *m;
			const auto* r = js::arr(machine, "rect");
			if (!r || r->size() != 4) {
				if (auto* imgs = js::arr(*entry, "images"); imgs && !imgs->empty()
					&& imgs->front().is_object()) {
					r = js::arr(imgs->front().as_object(), "rect");
				}
			}
			if (r && r->size() == 4) {
				rect = {
					static_cast<float>(r->at(0).to_number<double>()),
					static_cast<float>(r->at(1).to_number<double>()),
					static_cast<float>(r->at(2).to_number<double>()),
					static_cast<float>(r->at(3).to_number<double>()) };
			}
		}

		float machine_w = static_cast<float>(js::num(machine, "width", 0.0));
		float machine_h = static_cast<float>(js::num(machine, "height", 0.0));
		float machine_l = static_cast<float>(js::num(machine, "length", 0.0));
		const float mat_m = static_cast<float>(js::num(machine, "mat_m", 0.0));
		const float mat_px = static_cast<float>(js::num(machine, "mat_px", 0.0));

		float px_per_m = 0.0f;
		if (mat_m > 0 && mat_px > 0) px_per_m = mat_px / mat_m;
		else if (machine_l > 0 && rect.height > 0) px_per_m = rect.height / machine_l;
		else if (rect.height > 0) {
			// Метров нет: сцена в пикселях, размеры машины равны её ректу
			px_per_m = 1.0f;
			machine_w = rect.width;
			machine_l = rect.height;
			machine_h = std::min(rect.width, rect.height) * 0.3f;
		}
		m_renderer.set_scene(rect, machine_w, machine_h, machine_l, px_per_m);

		// Смена файла модели: перезагрузка прямо в потоке рендера,
		// запинка на кадр допустима так же, как у перепечки весов
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

	void UTopOutput::rebuild_photo_pairs() {
		std::vector<cv::Mat> remaps;
		std::vector<cv::Mat> weights;
		for (const auto& key : m_renderer.ordered_camera_keys()) {
			cv::Mat remap = gl_maps::load_remap_mat(m_maps_dir / (key + "_remap.bin"));
			cv::Mat weight = gl_maps::load_weight_mat(m_maps_dir / (key + "_weight.bin"));
			remaps.push_back(std::move(remap));
			weights.push_back(std::move(weight));
		}
		const auto pairs = UTopBaker::build_photo_pairs(remaps, weights);
		m_renderer.set_photometric_pairs(pairs);
		if (m_logger) m_logger->info("rebuild_photo_pairs(): pairs="
			+ std::to_string(pairs.size()));
	}

	bool UTopOutput::prepare(int& out_width, int& out_height, std::string& error) {
		if (!m_renderer.init(0, m_context, m_logger)) {
			error = "stitch renderer init failed";
			return false;
		}

		auto entry = m_store->read_export_entry(m_export_id);
		if (m_export_id.empty() || !entry) {
			error = "no active export";
			return false;
		}

		const std::string version = top_active_version(*entry);
		m_generation = top_version_generation(version);
		m_maps_dir = top_version_dir(m_store->exports_root(), m_export_id, version);

		if (!m_renderer.load_export(m_store->exports_root(),
			m_store->exports_index_file(), m_export_id)) {
			error = "no active export";
			return false;
		}

		// Поворот — параметр конфигурации, из формы канваса он не выводится
		m_renderer.set_rotation(m_rotation_degrees / 90);

		// Стороны округляются вверх до FRAME_ALIGNMENT, картинка растягивается
		out_width = align_frame_side(m_renderer.rotated_width());
		out_height = align_frame_side(m_renderer.rotated_height());

		// Всё новое только на версиях текущего поколения: v1 рисуется как раньше
		if (m_generation >= TOP_BAKE_GENERATION) {
			boost::json::object cfg;
			if (auto c = m_store->read_top_cfg(m_export_id)) cfg = *c;
			apply_visuals(cfg);
			rebuild_photo_pairs();

			// Пользовательское разрешение: вписывание с полями вместо растяжения
			if (auto* r = js::obj(cfg, "resolution")) {
				out_width = clamp_frame_side(
					js::num(*r, "width", out_width), SURROUND_RES_MIN, SURROUND_RES_MAX_W);
				out_height = clamp_frame_side(
					js::num(*r, "height", out_height), SURROUND_RES_MIN, SURROUND_RES_MAX_H);
				m_renderer.set_fit_output(true);
			}
		}
		if (m_dirty) m_dirty->store(0);

		m_renderer.set_output_size(out_width, out_height);

		if (m_logger) {
			m_logger->info("UTopOutput::prepare(): src="
				+ std::to_string(m_renderer.canvas_width()) + "x"
				+ std::to_string(m_renderer.canvas_height())
				+ ", out=" + std::to_string(out_width) + "x" + std::to_string(out_height)
				+ ", rotation=" + std::to_string(m_rotation_degrees)
				+ ", version=" + version);
		}
		return true;
	}

	std::vector<std::string> UTopOutput::camera_keys() const {
		return m_renderer.ordered_camera_keys();
	}

	bool UTopOutput::apply_live_changes() {
		if (m_generation < TOP_BAKE_GENERATION) return false;

		if (const unsigned dirty = m_dirty ? m_dirty->exchange(0) : 0) {
			boost::json::object cfg;
			if (auto c = m_store->read_top_cfg(m_export_id)) cfg = *c;
			if (dirty & TOP_DIRTY_VISUAL) {
				apply_visuals(cfg);
			}
			if (dirty & TOP_DIRTY_WEIGHTS) {
				// Коммит слайдера шва перепёк файлы весов активной версии
				m_renderer.reload_weights();
				rebuild_photo_pairs();
			}
		}
		return false;
	}

	void UTopOutput::render_frame(std::vector<NPFrame>& frames, float dt, EGLDisplay display) {
		(void)dt;
		m_renderer.update_textures(frames, display);
		m_renderer.update(0.0f);
		m_renderer.render(1.0f);
	}

} // birdview
} // varan
