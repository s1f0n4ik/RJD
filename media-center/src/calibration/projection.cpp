#include "calibration/calibrator.h"
#include "core/paths.h"
#include "calibration/constants.h"
#include "calibration/utility.h"
#include "signaling_definers.h"

#include "bird-view/top-bake.h"

namespace varan {
namespace calibration {

    void UCalibrator::handle_projection_configuration(
        const std::string& client_id,
        const boost::json::object& meta,
        COnError on_error)
    {
        std::string method;
        if (auto* v = meta.if_contains(constants::META_PROJECTION_METHOD); v && v->is_string()) {
            method = v->as_string();
        }
        else {
            if (on_error) on_error(constants::TYPE_PROJECTION_CONFIGURATION,
                "Error: missing or invalid <method> at meta block!",
                &client_id);
            return;
        }

        if (method == constants::METHOD_PROJECTION_GET_LIST) {
            if (!m_projection_config.read(varan::paths().surround.presets_json)) {
                if (on_error) on_error(constants::TYPE_PROJECTION_CONFIGURATION,
                    "Error: cannot read projection configuration file at server!",
                    &client_id);
                return;
            }

            auto presets = m_projection_config.list_presets();

            boost::json::object send_meta;
            send_meta[constants::META_PROJECTION_METHOD] = constants::METHOD_PROJECTION_GET_LIST;
            send_meta[constants::META_PROJECTION_PRESETS] = presets;
            send_message(make_socket_message(constants::TYPE_PROJECTION_CONFIGURATION,
                true, &client_id, &m_name, &send_meta));
            return;
        }

        // ----------------------- Устанвока пресета -----------------------
        if (method == constants::METHOD_PROJECTION_SET_PRESET) {
            std::string config_key;
            if (auto* v = meta.if_contains(constants::META_PROJECTION_CONFIG_KEY); v && v->is_string()) {
                config_key = v->as_string();
            }
            else {
                if (on_error) on_error(constants::TYPE_PROJECTION_CONFIGURATION,
                    "Error: missing or invalid <config_key> at meta block!",
                    &client_id);
                return;
            }

            if (!m_projection_config.read(varan::paths().surround.presets_json)) {
                if (on_error) on_error(constants::TYPE_PROJECTION_CONFIGURATION,
                    "Error: cannot read projection configuration file at server!",
                    &client_id);
                return;
            }

            auto opt_preset = m_projection_config.load_preset(config_key);
            if (!opt_preset) {
                if (on_error) on_error(constants::TYPE_PROJECTION_CONFIGURATION,
                    "Error: projection preset not found: " + config_key,
                    &client_id);
                return;
            }

            // активация пресета 
            {
                std::lock_guard<std::mutex> preset_lk(m_active_preset_mutex);
                m_active_preset = std::move(*opt_preset);

                {
                    std::lock_guard<std::mutex> canvas_lk(m_cached_image_mutex);
                    if (m_active_preset->canvas_size.width > 0 &&
                        m_active_preset->canvas_size.height > 0) {
                        m_canvas = cv::Mat::zeros(m_active_preset->canvas_size, CV_8UC3);
                    }
                    else {
                        m_canvas.release();
                    }
                }

                // Сброс настроек
                m_warped_mats.clear();
                m_warp_extras.clear();
                m_saved_to_warp_camera_images.clear();
            }

            // ---- собираем ответ клиенту ----
            boost::json::object send_meta;
            send_meta[constants::META_PROJECTION_METHOD] = constants::METHOD_PROJECTION_SET_PRESET;
            send_meta[constants::META_PROJECTION_CONFIG_KEY] = config_key;

            {
                std::lock_guard<std::mutex> preset_lk(m_active_preset_mutex);
                const auto& preset = *m_active_preset;

                send_meta[constants::META_PROJECTION_NAME] = preset.name;

                // Канвас клиенту не нужен
                //boost::json::object canvas;
                //canvas[constants::PROJ_WIDTH] = preset.canvas_size.width;
                //canvas[constants::PROJ_HEIGHT] = preset.canvas_size.height;
                //send_meta[constants::META_PROJECTION_CANVAS] = std::move(canvas);

                // Отправляем список камер
                boost::json::array cameras;
                for (const auto& [camera_key, cam] : preset.cameras) {
                    boost::json::object item;
                    item[constants::META_PROJECTION_KEY] = camera_key;
                    item[constants::PROJ_CAM_NAME] = cam.name;
                    item[constants::META_PROJECTION_MAX_POINTS] = static_cast<int>(cam.dst_points.size());
                    item[constants::META_PROJECTION_POINTS_COUNT] = static_cast<int>(cam.src_points.size());
                    // Сохранённая привязка места: клик по нему переключает камеру
                    if (!cam.camera_id.empty()) {
                        item[constants::META_PROJECTION_CAMERA_ID] = cam.camera_id;
                    }
                    // Ключ конфигурации коррекции, с которой размечали
                    if (!cam.calibration_key.empty()) {
                        item["calibration"] = cam.calibration_key;
                    }

                    // Сохранённые точки отдаём клиенту целиком, чтобы он мог их восстановить.
                    // Координаты нормированные, поэтому не зависят от разрешения камеры.
                    boost::json::array saved_points;
                    for (const auto& p : cam.src_points) {
                        boost::json::object point;
                        point["x"] = p.x;
                        point["y"] = p.y;
                        saved_points.push_back(std::move(point));
                    }
                    item[constants::META_PROJECTION_SRC_POINTS] = std::move(saved_points);

                    cameras.push_back(std::move(item));
                }
                /*
                for (const auto& camera_key : constants::camera_position_keys()) {
                    auto it = preset.cameras.find(camera_key);
                    if (it == preset.cameras.end()) continue;
                    const auto& cam = it->second;

                    boost::json::object item;
                    item[constants::META_PROJECTION_KEY] = cam.key;
                    item[constants::META_PROJECTION_MAX_POINTS] = static_cast<int>(cam.dst_points.size());
                    item[constants::META_PROJECTION_POINTS_COUNT] = static_cast<int>(cam.src_points.size());
                    cameras.push_back(std::move(item));
                }
                */
                send_meta[constants::META_PROJECTION_CAMERAS] = std::move(cameras);
            }

            send_message(make_socket_message(constants::TYPE_PROJECTION_CONFIGURATION,
                true, &client_id, &m_name, &send_meta));
            m_logger.info("handle_projection_configuration(): applied preset <" + config_key + ">");
            return;
        }

        // ----------------------- Применение warp -----------------------
        if (method == constants::METHOD_PROJECTION_APPLY_WARP) { 
            std::string camera_key;
            if (auto* v = meta.if_contains(constants::META_PROJECTION_KEY); v && v->is_string()) {
                camera_key = v->as_string();
            }
            else {
                if (on_error) on_error(constants::TYPE_PROJECTION_CONFIGURATION,
                    "Error: missing or invalid <key> at meta block!",
                    &client_id);
                return;
            }

            std::vector<cv::Point2f> src_points;
            if (auto* v = meta.if_contains(constants::META_PROJECTION_SRC_POINTS); v && v->is_array()) {
                for (const auto& p : v->as_array()) {
                    if (p.is_object()) {
                        const auto* xv = p.as_object().if_contains("x");
                        const auto* yv = p.as_object().if_contains("y");

                        if (xv && yv && xv->is_number() && yv->is_number()) {
                            float x = static_cast<float>(xv->to_number<double>());
                            float y = static_cast<float>(yv->to_number<double>());

                            src_points.emplace_back(x, y);
                        }
                    }
                }
            }
            else {
                if (on_error)
                    on_error(constants::TYPE_PROJECTION_CONFIGURATION,
                        "Error: missing or invalid src_points!",
                        &client_id);

                return;
            }

            m_logger.info((std::ostringstream() << src_points).str());

            // Поулчаем сам канвас и точки названчения на канвас
            cv::Size canvas; std::vector<cv::Point2f> dst_points; std::string error;
            if (!extract_canvas_dst_points(camera_key, src_points, canvas, dst_points, error)) {
                if (on_error) on_error(constants::TYPE_PROJECTION_CONFIGURATION, error, &client_id);
                return;
            }

            try {
                // Нормированные точки нужны для сохранения в пресет: они не зависят
                // от разрешения камеры, поэтому переживают смену камеры и конфигурации коррекции
                const std::vector<cv::Point2f> normalized_src_points = src_points;

                // Получаем координаты в абсолютном формате
                const float W = static_cast<float>(m_raw_image.width);
                const float H = static_cast<float>(m_raw_image.height);
                for (auto& p : src_points) {
                    p.x *= W;
                    p.y *= H;
                }

                // Строим карты проекции текущей камеры на канвас
                std::string error; cv::Mat proj_map_x; cv::Mat proj_map_y;
                if (!birdview::UTopBaker::build_warp_remap(src_points, dst_points, canvas,
                    proj_map_x, proj_map_y, error)) {
                    if (on_error) on_error(constants::TYPE_PROJECTION_CONFIGURATION, error, &client_id);
                    return;
                }

                {
                    std::lock_guard<std::mutex> lock(m_active_preset_mutex);
                    m_warped_mats[camera_key] = std::make_pair(std::move(proj_map_x), std::move(proj_map_y));

                    // Секторные веса зависят от всех камер разом: новая зона
                    // двигает швы соседей, поэтому пересчёт идёт целиком
                    if (!rebuild_warp_extras()) {
                        if (on_error) on_error(constants::TYPE_PROJECTION_CONFIGURATION,
                            "Error: failed to build warp extras for camera <" + camera_key + ">",
                            &client_id);
                        return;
                    }
                }
                
                // Получение кадра
                cv::Mat screenshot;
                if (!get_image_to_build(screenshot, error)) {
                    if (on_error) on_error(constants::TYPE_PROJECTION_CONFIGURATION, error, &client_id);
                    return;
                }

                {
                    std::lock_guard<std::mutex> lock(m_active_preset_mutex);
                    m_saved_to_warp_camera_images[camera_key] = screenshot;
                }

                // Сборка канваса
                if (!build_canvas(error)) {
                    if (on_error) on_error(constants::TYPE_PROJECTION_CONFIGURATION, error, &client_id);
                    return;
                }

                // Точки запоминаем в пресете только после удачной сборки, чтобы на диск
                // не попадала разметка, которая не даёт результата
                if (!save_src_points(camera_key, normalized_src_points)) {
                    m_logger.warn("handle_projection_configuration(): cannot save src_points for camera <"
                        + camera_key + ">");
                }

                // Отправляем канвас
                boost::json::object send_meta;
                send_meta[constants::META_PROJECTION_METHOD] = constants::METHOD_PROJECTION_APPLY_WARP;
                send_meta[constants::META_PROJECTION_KEY] = camera_key;
                send_meta[constants::META_PROJECTION_CAMERA_ID] = m_camera_id;
                // Ключ коррекции по правилу записи в пресет; без него фронт
                // стирает метку у места
                if (m_undistort.ready && !m_loaded_calibration_key.empty()) {
                    send_meta["calibration"] = m_loaded_calibration_key;
                }

                if (!send_canvas_as_binary(client_id, send_meta, error)) {
                    if (on_error) on_error(constants::TYPE_PROJECTION_CONFIGURATION, error, &client_id);
                    return;
                }
                return;
            }
            catch (const std::exception& error) {
                if (on_error) on_error(constants::TYPE_PROJECTION_CONFIGURATION, "Server error: " + std::string(error.what()), &client_id);
                return;
            }

        }

        // ----------------------- Сброс печки warp --------------------------
        if (method == constants::METHOD_PROJECTION_RESET_WARP) {
            // Точки и привязки пресета не трогаются: сбрасываются только
            // карты сессии, снятые кадры и превью-канвас
            {
                std::lock_guard<std::mutex> lock(m_active_preset_mutex);
                m_warped_mats.clear();
                m_warp_extras.clear();
                m_saved_to_warp_camera_images.clear();
            }
            {
                std::lock_guard<std::mutex> canvas_lk(m_cached_image_mutex);
                if (!m_canvas.empty()) {
                    m_canvas = cv::Mat::zeros(m_canvas.size(), CV_8UC3);
                }
            }

            boost::json::object send_meta;
            send_meta[constants::META_PROJECTION_METHOD] = constants::METHOD_PROJECTION_RESET_WARP;
            send_message(make_socket_message(constants::TYPE_PROJECTION_CONFIGURATION,
                true, &client_id, &m_name, &send_meta));
            m_logger.info("handle_projection_configuration(): warp session reset");
            return;
        }

        // ----------------------- Сохранение LUT в OpenGL формате --------------------------
        if (method == constants::METHOD_PROJECTION_SAVE_LUT) {
            handle_save_lut(client_id, meta, on_error);
            return;
        }

        if (on_error) on_error(constants::TYPE_PROJECTION_CONFIGURATION,
            "Error: unresolved method at projection configuration request!",
            &client_id);
    }

    bool UCalibrator::build_canvas(std::string& error) {
        cv::Size canvas_size;
        {
            std::lock_guard<std::mutex> preset_lk(m_active_preset_mutex);
            if (!m_active_preset) {
                error = "build_canvas(): no active projection preset";
                return false;
            }
            canvas_size = m_active_preset->canvas_size;
        }
        if (canvas_size.width <= 0 || canvas_size.height <= 0) {
            error = "build_canvas(): invalid canvas size";
            return false;
        }

        // Собираем валидные камеры (есть снимок + remap + extras).
        struct FFeedItem {
            std::string key;
            cv::Mat warped;   // CV_8UC3 (RGB) после remap
            cv::Mat weight;   // CV_32FC1 — секторные веса 0..1, посчитаны заранее
        };
        std::vector<FFeedItem> items;
        items.reserve(m_saved_to_warp_camera_images.size());

        for (const auto& [key, snapshot] : m_saved_to_warp_camera_images) {
            if (snapshot.empty()) continue;

            auto map_it = m_warped_mats.find(key);
            if (map_it == m_warped_mats.end()) {
                m_logger.warn("build_canvas(): no remap for <" + key + ">, skip");
                continue;
            }
            auto extras_it = m_warp_extras.find(key);
            if (extras_it == m_warp_extras.end()) {
                m_logger.warn("build_canvas(): no extras for <" + key + ">, skip");
                continue;
            }

            cv::Mat warped;
            cv::remap(snapshot, warped, map_it->second.first, map_it->second.second, cv::INTER_LINEAR, cv::BORDER_REPLICATE);

            items.push_back({
                key,
                std::move(warped),
                extras_it->second.weight
                });
        }

        std::lock_guard<std::mutex> canvas_lk(m_cached_image_mutex);

        if (items.empty()) {
            m_canvas = cv::Mat::zeros(canvas_size, CV_8UC3);
            return true;
        }

        // Ручное смешивание по заранее посчитанным секторным весам:
        // превью показывает те же швы, что рендер линкера
        cv::Mat acc = cv::Mat::zeros(canvas_size, CV_32FC3);
        cv::Mat wsum = cv::Mat::zeros(canvas_size, CV_32FC1);

        for (auto& it : items) {
            cv::Mat warped_f;
            it.warped.convertTo(warped_f, CV_32FC3);

            // Поканально умножаем на вес и аккумулируем.
            std::vector<cv::Mat> ch(3);
            cv::split(warped_f, ch);
            for (auto& c : ch) {
                cv::multiply(c, it.weight, c);
            }
            cv::Mat weighted;
            cv::merge(ch, weighted);

            cv::add(acc, weighted, acc);
            cv::add(wsum, it.weight, wsum);
        }

        // Делим на сумму весов там, где она > 0.
        cv::Mat wsum_safe;
        cv::max(wsum, 1e-5f, wsum_safe);  // защита от деления на 0

        std::vector<cv::Mat> acc_ch(3);
        cv::split(acc, acc_ch);
        for (auto& c : acc_ch) {
            cv::divide(c, wsum_safe, c);
        }
        cv::Mat result_f;
        cv::merge(acc_ch, result_f);

        result_f.convertTo(m_canvas, CV_8UC3);

        // За пределами всех масок — чёрный.
        cv::Mat any_mask = wsum > 0.0f;  // CV_8UC1
        cv::Mat inv_mask;
        cv::bitwise_not(any_mask, inv_mask);
        m_canvas.setTo(cv::Scalar::all(0), inv_mask);

        return true;
    }

    /*
        Секторные веса превью по всем камерам с применённым warp.

        Та же печка, что у экспорта и линкера: Вороной по центроидам зон
        с шириной шва по умолчанию. Свой blend появляется у конфигурации
        только после экспорта, поэтому превью всегда с дефолтным.

        ВАЖНО: лок m_active_preset_mutex берётся снаружи, как для m_warped_mats.
    */
    bool UCalibrator::rebuild_warp_extras() {
        if (!m_active_preset) {
            m_logger.error("rebuild_warp_extras(): no active preset");
            return false;
        }
        if (m_warped_mats.empty()) {
            m_warp_extras.clear();
            return true;
        }

        const cv::Size raw{ m_raw_image.width, m_raw_image.height };
        if (raw.width <= 0 || raw.height <= 0) {
            m_logger.error("rebuild_warp_extras(): invalid snapshot size");
            return false;
        }

        std::vector<std::string> keys;
        std::vector<cv::Mat> remaps;
        std::vector<cv::Point2f> centers;
        std::vector<std::vector<cv::Point2f>> regions;
        cv::Size canvas{ 0, 0 };

        for (const auto& [key, maps] : m_warped_mats) {
            const cv::Mat& mx = maps.first;
            const cv::Mat& my = maps.second;
            if (mx.empty() || my.empty() || mx.size() != my.size()) {
                m_logger.error("rebuild_warp_extras(<" + key + ">): invalid maps");
                return false;
            }
            canvas = mx.size();

            // Печка ждёт нормированный remap: валидность и затухание от него
            cv::Mat norm(canvas, CV_32FC2);
            const float inv_W = 1.0f / static_cast<float>(raw.width);
            const float inv_H = 1.0f / static_cast<float>(raw.height);
            for (int y = 0; y < canvas.height; ++y) {
                const float* rx = mx.ptr<float>(y);
                const float* ry = my.ptr<float>(y);
                cv::Vec2f* out = norm.ptr<cv::Vec2f>(y);
                for (int x = 0; x < canvas.width; ++x) {
                    if (rx[x] < 0.0f || ry[x] < 0.0f
                        || rx[x] >= raw.width || ry[x] >= raw.height) {
                        out[x] = cv::Vec2f(-1.0f, -1.0f);
                    }
                    else {
                        out[x] = cv::Vec2f(rx[x] * inv_W, ry[x] * inv_H);
                    }
                }
            }

            cv::Point2f center{ canvas.width * 0.5f, canvas.height * 0.5f };
            std::vector<cv::Point2f> region;
            if (auto cam_it = m_active_preset->cameras.find(key);
                cam_it != m_active_preset->cameras.end()) {
                region = !cam_it->second.canvas_region.empty()
                    ? cam_it->second.canvas_region
                    : birdview::UTopBaker::hull_of(cam_it->second.dst_points);
                if (!region.empty()) center = birdview::UTopBaker::region_centroid(region);
            }

            keys.push_back(key);
            remaps.push_back(std::move(norm));
            centers.push_back(center);
            regions.push_back(std::move(region));
        }

        std::vector<cv::Mat> weights;
        birdview::UTopBaker::build_weights(canvas, remaps, centers, regions,
            birdview::TOP_BLEND_DEFAULT, weights);

        m_warp_extras.clear();
        for (size_t i = 0; i < keys.size(); ++i) {
            m_warp_extras[keys[i]] = FWarpExtras{ std::move(weights[i]) };
        }
        return true;
    }

    bool UCalibrator::extract_canvas_dst_points(
        const std::string& camera_key,
        const std::vector<cv::Point2f>& src_points,
        cv::Size& canvas_size, 
        std::vector<cv::Point2f>& dst_points, 
        std::string& str_err) 
    {
        std::lock_guard<std::mutex> lock_preset(m_active_preset_mutex);
        if (!m_active_preset) {
            str_err = "Error: no active projection preset on server!";
            return false;
        }

        auto cam_it = m_active_preset->cameras.find(camera_key);
        if (cam_it == m_active_preset->cameras.end()) {
            str_err = "Error: camera <" + camera_key + "> not found in active preset!";
            return false;
        }

        if (cam_it->second.dst_points.empty()) {
            str_err = "Error: camera <" + camera_key + "> has no dst_points configured!";
            return false;
        }

        if (src_points.size() != cam_it->second.dst_points.size()) {
            str_err = "Error: src_points count (" + std::to_string(src_points.size()) +
                ") != dst_points count (" + std::to_string(cam_it->second.dst_points.size()) + ")";
            return false;
        }

        dst_points = cam_it->second.dst_points; 
        canvas_size = m_active_preset->canvas_size;
        return true;
    }

    bool UCalibrator::save_src_points(
        const std::string& camera_key,
        const std::vector<cv::Point2f>& normalized_src_points)
    {
        FProjectionPreset preset_copy;
        {
            std::lock_guard<std::mutex> lock_preset(m_active_preset_mutex);
            if (!m_active_preset) {
                m_logger.warn("save_src_points(): no active projection preset");
                return false;
            }

            auto cam_it = m_active_preset->cameras.find(camera_key);
            if (cam_it == m_active_preset->cameras.end()) {
                m_logger.warn("save_src_points(): camera <" + camera_key + "> not found in active preset");
                return false;
            }

            cam_it->second.src_points = normalized_src_points;
            // Привязка места к физической камере: чей кадр размечали, та и пишется
            if (!m_camera_id.empty()) {
                cam_it->second.camera_id = m_camera_id;
            }
            // Ключ конфигурации коррекции по правилу компоновки карт: живые
            // undistort-карты сессии из load - пишется, иначе стирается
            if (m_undistort.ready && !m_loaded_calibration_key.empty()) {
                cam_it->second.calibration_key = m_loaded_calibration_key;
            }
            else {
                cam_it->second.calibration_key.clear();
            }
            preset_copy = *m_active_preset;
        }

        // Свежий файл перед мёржем: пресет параллельно правит конфигуратор,
        // и мёрж в старую копию затирал бы его габарит и картинки
        if (!m_projection_config.read(varan::paths().surround.presets_json)) {
            m_logger.warn("save_src_points(): cannot re-read presets before merge");
        }

        // Пресет писать под локом нельзя: запись на диск держала бы обработку кадров
        if (!m_projection_config.save_preset(preset_copy)) {
            return false;
        }

        return m_projection_config.save(varan::paths().surround.presets_json);
    }

    bool UCalibrator::get_image_to_build(cv::Mat& out, std::string& error) {
        cv::Mat image;
        // Включаем цикл обнаружения кешированного изображения с таймайтом в 2 секунды
        auto start = std::chrono::steady_clock::now();
        auto timeout = std::chrono::seconds(2);
        while (true) {
            {
                std::lock_guard<std::mutex> lock(m_cached_image_mutex);
                image = std::move(m_cached_image);
            }
            if (image.empty()) {
                if (std::chrono::steady_clock::now() - start > timeout) {
                    error = "Server error: get_image_to_build(): timeout of waiting for camera image!";
                    return false;
                }
                std::this_thread::sleep_for(std::chrono::milliseconds(30));
            }
            else {
                break;
            }
        }

        // Если вкдючена коррекция, то применяем ее
        if (m_apply_undistort) {
            apply_undistort_maps(image, out);
        }
        else {
            out = std::move(image);
        }

        if (out.empty()) {
            error = "Server error: camera image is empty!";
            return false;
        }
        return true;
    }

    bool UCalibrator::save_stitching_export(
        const std::filesystem::path& export_root,
        const std::string& id,
        const std::string& display_name,
        std::string& error
    ) {
        std::ostringstream oss;
        oss << "save_stitching_export(): begin export, id=<" << id << ">, name=<" << display_name
            << ">, root=<" << export_root << ">";
        m_logger.info(oss.str());

        // Снапшот всего, что нам нужно из активного пресета.
        cv::Size canvas_size;
        boost::json::array overlay_images;
        std::unordered_map<std::string, FProjectionCamera> cams_copy;
        std::string preset_key;
        {
            std::lock_guard<std::mutex> preset_lk(m_active_preset_mutex);
            if (!m_active_preset) {
                error = "save_stitching_export(): no active projection preset";
                return false;
            }
            canvas_size = m_active_preset->canvas_size;
            cams_copy = m_active_preset->cameras;
            preset_key = m_active_preset->key;
            try {
                overlay_images = m_projection_config.serialize_images(m_active_preset->images);
            }
            catch (...) {
                m_logger.warn("save_stitching_export(): cannot serialize images from active preset!");
            }
        }

        // Габарит и метры мира из пресета: печка и схема линкера читают их
        // из записи экспорта, модель пресета этот блок не разбирает
        boost::json::value machine_block;
        bool has_machine = false;
        try {
            std::ifstream pf(varan::paths().surround.presets_json);
            if (pf) {
                std::stringstream pss; pss << pf.rdbuf();
                auto pv = boost::json::parse(pss.str());
                if (pv.is_object()) {
                    if (auto* p = pv.as_object().if_contains(preset_key); p && p->is_object()) {
                        if (auto* m = p->as_object().if_contains("machine"); m && m->is_object()) {
                            machine_block = *m;
                            has_machine = true;
                        }
                    }
                }
            }
        }
        catch (...) {
            m_logger.warn("save_stitching_export(): cannot read machine block from presets");
        }
        if (canvas_size.width <= 0 || canvas_size.height <= 0) {
            error = "save_stitching_export(): invalid canvas size";
            return false;
        }
        if (id.empty()) {
            error = "save_stitching_export(): empty id";
            return false;
        }

        m_logger.debug(
            "save_stitching_export(): preset snapshot acquired, canvas=" +
            std::to_string(canvas_size.width) + "x" +
            std::to_string(canvas_size.height) +
            ", cameras=" + std::to_string(cams_copy.size())
        );

        // Размер raw, к которому будут нормализованы remap-координаты.
        const cv::Size raw_size{ m_raw_image.width, m_raw_image.height };

        m_logger.debug("save_stitching_export(): raw image size=" + std::to_string(raw_size.width) + "x" + std::to_string(raw_size.height));

        // Undistort-карты текущей сессии. У UCalibrator одна камера за раз,
        // поэтому только текущие m_undistort.matrix_x/y релевантны.
        cv::Mat undist_x, undist_y;
        if (m_undistort.ready && !m_undistort.matrix_x.empty() && !m_undistort.matrix_y.empty()) {
            std::lock_guard<std::mutex> ulk(m_undistort_mutex);
            undist_x = m_undistort.matrix_x;
            undist_y = m_undistort.matrix_y;

            m_logger.debug(
                "save_stitching_export(): undistort maps copied, size=" +
                std::to_string(undist_x.cols) + "x" +
                std::to_string(undist_x.rows)
            );

            m_logger.debug("undist_x type=" + std::to_string(m_undistort.matrix_x.type()));
            m_logger.debug("undist_y type=" + std::to_string(m_undistort.matrix_y.type()));
        }
        else {
            m_logger.warn("save_stitching_export(): undistort maps are not ready");
        }

        // Композиция remap на камеру; веса и запись индекса делает печка
        birdview::UTopBaker baker(&m_logger);
        std::vector<birdview::FTopBakeCamera> baked;

        for (const auto& [cam_key, cam] : cams_copy) {
            auto warp_it = m_warped_mats.find(cam_key);
            if (warp_it == m_warped_mats.end()) {
                m_logger.warn("save_stitching_export(): skip <" + cam_key + ">, no warp");
                continue;
            }

            cv::Mat remap_norm;
            std::string compose_error;
            if (!baker.compose_remap_to_raw(
                warp_it->second.first, warp_it->second.second,
                undist_x, undist_y,
                raw_size, remap_norm, compose_error)
            ){
                m_logger.error("save_stitching_export(): compose failed for <" + cam_key
                    + ">: " + compose_error);
                continue;
            }

            birdview::FTopBakeCamera item;
            item.key = cam_key;
            // Имя места из пресета. По нему линкер показывает, какую камеру куда
            // ставить: ключи вроде left_front оператору ничего не говорят
            item.name = cam.name;
            item.camera_id = cam.camera_id;
            item.remap = std::move(remap_norm);
            item.region = !cam.canvas_region.empty()
                ? cam.canvas_region : birdview::UTopBaker::hull_of(cam.dst_points);
            baked.push_back(std::move(item));

            m_logger.info("save_stitching_export(): composed camera <" + cam_key + ">");
        }

        // Имя, картинки, габарит и ключ пресета кладутся поверх записи;
        // ключ нужен пересчёту в линкере, чтобы найти src-точки
        boost::json::object patch;
        patch["name"] = display_name;
        patch["images"] = overlay_images;
        patch["preset"] = preset_key;
        if (has_machine) patch["machine"] = machine_block;

        // Карта калибровки из пресета: surround-печка ищет по ней записи камер
        boost::json::object calib_map;
        for (const auto& [cam_key, cam] : cams_copy) {
            if (!cam.camera_id.empty() && !cam.calibration_key.empty()) {
                calib_map[cam.camera_id] = cam.calibration_key;
            }
        }

        if (!baker.save_export(export_root, constants::LINKER_CONFIGURATION_INDEX,
            id, canvas_size, baked, patch, calib_map, error)) {
            m_logger.error("save_stitching_export(): " + error);
            return false;
        }

        m_logger.info("save_stitching_export(): exported " + std::to_string(baked.size())
            + " cameras under id <" + id + ">");
        return true;
    }

    void UCalibrator::handle_save_lut(
        const std::string& client_id, 
        const boost::json::object& meta, 
        COnError on_error
    ) {
        // 1) Парсим id и name из meta.
        std::string id;
        if (auto* v = meta.if_contains(constants::META_PROJECTION_ID); v && v->is_string()) {
            id = v->as_string();
        }
        else {
            if (on_error) on_error(constants::TYPE_PROJECTION_CONFIGURATION,
                "Error: missing or invalid <id> at meta block!",
                &client_id);
            return;
        }
        if (id.empty()) {
            if (on_error) on_error(constants::TYPE_PROJECTION_CONFIGURATION,
                "Error: <id> cannot be empty",
                &client_id);
            return;
        }

        // Защита от path-traversal: id используется как имя подкаталога.
        // Допускаем только [a-zA-Z0-9_-].
        for (char c : id) {
            const bool ok = (c >= 'a' && c <= 'z')
                || (c >= 'A' && c <= 'Z')
                || (c >= '0' && c <= '9')
                || c == '_' || c == '-';
            if (!ok) {
                if (on_error) on_error(constants::TYPE_PROJECTION_CONFIGURATION,
                    "Error: <id> contains invalid characters (allowed: a-z, A-Z, 0-9, _, -)",
                    &client_id);
                return;
            }
        }

        std::string display_name;
        if (auto* v = meta.if_contains(constants::META_PROJECTION_NAME); v && v->is_string()) {
            display_name = v->as_string();
        }
        else {
            if (on_error) on_error(constants::TYPE_PROJECTION_CONFIGURATION,
                "Error: missing or invalid <name> at meta block!",
                &client_id);
            return;
        }

        // 2) Проверка готовности: все камеры активного пресета должны иметь warp + extras.
        {
            std::lock_guard<std::mutex> preset_lk(m_active_preset_mutex);
            if (!m_active_preset) {
                if (on_error) on_error(constants::TYPE_PROJECTION_CONFIGURATION,
                    "Error: no active projection preset on server!",
                    &client_id);
                return;
            }
            for (const auto& [cam_key, cam] : m_active_preset->cameras) {
                if (m_warped_mats.find(cam_key) == m_warped_mats.end() ||
                    m_warp_extras.find(cam_key) == m_warp_extras.end())
                {
                    if (on_error) on_error(constants::TYPE_PROJECTION_CONFIGURATION,
                        "Error: camera <" + cam_key + "> has no applied warp",
                        &client_id);
                    return;
                }
            }
        }

        // 3) Экспорт.
        std::string error;
        if (!save_stitching_export(varan::paths().surround.projection_root, id, display_name, error)) {
            if (on_error) on_error(constants::TYPE_PROJECTION_CONFIGURATION,
                "Error: failed to save stitching export <" + id + ">:" + error,
                &client_id);
            return;
        }

        // 4) Ответ клиенту.
        boost::json::object send_meta;
        send_meta[constants::META_PROJECTION_METHOD] = constants::METHOD_PROJECTION_SAVE_LUT;
        send_meta[constants::META_PROJECTION_ID] = id;
        send_meta[constants::META_PROJECTION_NAME] = display_name;

        send_message(make_socket_message(constants::TYPE_PROJECTION_CONFIGURATION, true, &client_id, &m_name, &send_meta));
        m_logger.info("save_lut: exported configuration <" + id + ">");
        return;
    }

    bool UCalibrator::send_canvas_as_binary(const std::string& client_id, const boost::json::object& meta, std::string& error) {
        std::vector<uint8_t> buf;
        try {
            std::lock_guard<std::mutex> canvas_lk(m_cached_image_mutex);
            //cv::Mat to_encode;
            //cv::cvtColor(m_canvas, to_encode, cv::COLOR_RGB2BGR);
            cv::imencode(".jpg", m_canvas, buf, { cv::IMWRITE_JPEG_QUALITY, 100 });
        }
        catch (const std::exception& err) {
            error = "Internal error during canvas encoding : " + std::string(err.what());
            return false;
        }

        send_binary(make_socket_message(constants::TYPE_PROJECTION_CONFIGURATION, true, &client_id, &m_name, &meta, &buf));
        return true;
    }

};
};

