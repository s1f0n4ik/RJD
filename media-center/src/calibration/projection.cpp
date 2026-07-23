#include "calibration/calibrator.h"
#include "calibration/constants.h"
#include "calibration/utility.h"
#include "calibration/json-export.h"
#include "signaling_definers.h"

#include "utility/gl-maps.h"

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
            if (!m_projection_config.read(constants::PROJECTION_CONFIGURES_PATH)) {
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

            if (!m_projection_config.read(constants::PROJECTION_CONFIGURES_PATH)) {
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
                if (!build_warp_remap(src_points, dst_points, canvas, proj_map_x, proj_map_y, error)) {
                    if (on_error) on_error(constants::TYPE_PROJECTION_CONFIGURATION, error, &client_id);
                    return;
                }

                {
                    std::lock_guard<std::mutex> lock(m_active_preset_mutex);
                    m_warped_mats[camera_key] = std::make_pair(std::move(proj_map_x), std::move(proj_map_y));

                    std::vector<cv::Point2f> region_pts;
                    std::vector<cv::Point2f> dst_pts_copy;
                    {
                        // m_active_preset_mutex уже захвачен на этом участке.
                        auto cam_it = m_active_preset->cameras.find(camera_key);
                        if (cam_it != m_active_preset->cameras.end()) {
                            region_pts = cam_it->second.canvas_region;
                            dst_pts_copy = cam_it->second.dst_points;
                        }
                    }

                    const cv::Size snapshot_size{ m_raw_image.width, m_raw_image.height };

                    // Берём карты ИЗ контейнера, а не локальные (они уже moved выше).
                    const auto& mx_ref = m_warped_mats[camera_key].first;
                    const auto& my_ref = m_warped_mats[camera_key].second;

                    if (!build_warp_extras(camera_key, mx_ref, my_ref, snapshot_size, region_pts, dst_pts_copy)) {
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
            cv::Mat mask;     // CV_8UC1
            cv::Mat weight;   // CV_32FC1 — distance transform, посчитан заранее
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
                extras_it->second.mask,
                extras_it->second.weight
                });
        }

        std::lock_guard<std::mutex> canvas_lk(m_cached_image_mutex);

        if (items.empty()) {
            m_canvas = cv::Mat::zeros(canvas_size, CV_8UC3);
            return true;
        }

        // Ручной feather-blending по заранее посчитанным weight-картам.
        // (cv::detail::FeatherBlender внутри делает distanceTransform сам, что
        //  игнорирует наш canvas_region. Считаем сами: это буквально пара
        //  поканальных операций.)
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

    bool UCalibrator::build_warp_remap(
        const std::vector<cv::Point2f>& src_points,
        const std::vector<cv::Point2f>& dst_points,
        const cv::Size& canvas_size,
        cv::Mat& out_map_x,
        cv::Mat& out_map_y,
        std::string& error
    ) {
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

        // Чтобы построить map'ы, для каждого пикселя канваса (u,v) нужно найти
        // соответствующий пиксель в исходном изображении. Это обратное преобразование.
        cv::Mat H_inv;
        if (!cv::invert(H, H_inv)) {
            error = "build_warp_remap(): H is degenerate";
            return false;
        }

        // Готовим сетку точек канваса: { (0,0), (1,0), ..., (W-1, H-1) }
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

        // Раскладываем результат в две одноканальные карты.
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

    bool UCalibrator::build_warp_extras(
        const std::string& camera_key,
        const cv::Mat& map_x,
        const cv::Mat& map_y,
        const cv::Size& snapshot_size,
        const std::vector<cv::Point2f>& canvas_region,
        const std::vector<cv::Point2f>& dst_points)
    {
        if (map_x.empty() || map_y.empty() || map_x.size() != map_y.size()) {
            m_logger.error("build_warp_extras(<" + camera_key + ">): invalid maps");
            return false;
        }
        if (snapshot_size.width <= 0 || snapshot_size.height <= 0) {
            m_logger.error("build_warp_extras(<" + camera_key + ">): invalid snapshot size");
            return false;
        }

        const cv::Size canvas_size = map_x.size();

        // 1) Полигон зоны. Если canvas_region пуст — берём выпуклую оболочку dst_points.
        std::vector<cv::Point> region_int;
        if (!canvas_region.empty()) {
            region_int.reserve(canvas_region.size());
            for (const auto& p : canvas_region) {
                region_int.emplace_back(cvRound(p.x), cvRound(p.y));
            }
        }
        else if (!dst_points.empty()) {
            std::vector<cv::Point> dst_int;
            dst_int.reserve(dst_points.size());
            for (const auto& p : dst_points) {
                dst_int.emplace_back(cvRound(p.x), cvRound(p.y));
            }
            cv::convexHull(dst_int, region_int);
        }
        else {
            m_logger.error("build_warp_extras(<" + camera_key + ">): no region and no dst_points");
            return false;
        }

        // 2) Маска полигона.
        cv::Mat region_mask(canvas_size, CV_8UC1, cv::Scalar(0));
        {
            std::vector<std::vector<cv::Point>> polys{ region_int };
            cv::fillPoly(region_mask, polys, cv::Scalar(255));
        }

        // 3) Маска валидных source-координат (там, где remap указывает внутрь снимка).
        cv::Mat source_mask(canvas_size, CV_8UC1, cv::Scalar(0));
        {
            const float W = static_cast<float>(snapshot_size.width);
            const float H = static_cast<float>(snapshot_size.height);
            for (int y = 0; y < canvas_size.height; ++y) {
                const float* rx = map_x.ptr<float>(y);
                const float* ry = map_y.ptr<float>(y);
                uchar* row = source_mask.ptr<uchar>(y);
                for (int x = 0; x < canvas_size.width; ++x) {
                    const float sx = rx[x];
                    const float sy = ry[x];
                    if (sx >= 0.0f && sx < W && sy >= 0.0f && sy < H) {
                        row[x] = 255;
                    }
                }
            }
        }

        // 4) Итоговая маска = пересечение.
        cv::Mat mask;
        mask = region_mask.clone();

        cv::Mat mask_eroded;
        cv::erode(mask, mask_eroded, cv::getStructuringElement(cv::MORPH_RECT, cv::Size(3, 3)));

        cv::Mat weight;
        cv::distanceTransform(mask_eroded, weight, cv::DIST_L2, 3, CV_32F);

        // Внутри ИСХОДНОЙ маски (включая граничные пиксели, которые отрезала эрозия)
        // поднимаем weight до минимума >= 1, чтобы при нормализации не было 0.
        weight.setTo(1.0f, (mask > 0) & (weight < 1.0f));

        // Сохраняем в m_warp_extras рядом с m_warped_mats.
        // ВАЖНО: лок берётся снаружи (в обработчике apply_warp), как для m_warped_mats.
        m_warp_extras[camera_key] = FWarpExtras{ std::move(mask), std::move(weight) };

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
            preset_copy = *m_active_preset;
        }

        // Пресет писать под локом нельзя: запись на диск держала бы обработку кадров
        if (!m_projection_config.save_preset(preset_copy)) {
            return false;
        }

        return m_projection_config.save(constants::PROJECTION_CONFIGURES_PATH);
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

    bool UCalibrator::compose_remap_to_raw(
        const cv::Mat& warp_x, const cv::Mat& warp_y,
        const cv::Mat& undist_x, const cv::Mat& undist_y,
        const cv::Size& raw_size,
        cv::Mat& out_remap_32fc2,
        std::string& error
    ) {
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
        const bool has_undistort = !undist_x.empty() && !undist_y.empty() && undist_x.size() == undist_y.size();

        out_remap_32fc2.create(canvas_size, CV_32FC2);

        const float inv_W = 1.0f / static_cast<float>(raw_size.width);
        const float inv_H = 1.0f / static_cast<float>(raw_size.height);

        if (has_undistort) {
            // Превращаем undistort-карты в CV_32FC2 единой картой.
            // - Если на входе уже CV_32FC1 + CV_32FC1, мерджим.
            // - Если fixed-point (CV_16SC2 + CV_16UC1) — convertMaps с типом CV_32FC2
            //   сразу даст одну 2-канальную float-карту.
            cv::Mat undist_xy;
            if (undist_x.type() == CV_32FC1 && undist_y.type() == CV_32FC1) {
                std::vector<cv::Mat> ch{ undist_x, undist_y };
                cv::merge(ch, undist_xy);
            }
            else {
                cv::Mat dummy;
                cv::convertMaps(undist_x, undist_y, undist_xy, dummy,CV_32FC2, /*nninterpolation=*/false);
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
            m_logger.debug("compose_remap_to_raw(): no undistort maps, sipmple compose!");
            // Без undistort: warp уже указывает в raw напрямую.
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

        m_logger.debug((std::ostringstream() << 
            "compose_remap_to_raw(): successfully compose maps: " <<  out_remap_32fc2.cols << "x" + out_remap_32fc2.rows).str());
        return true;
    }

    /*
        Прямоугольник места камеры на канвасе.

        Запасное правило то же, что в build_warp_extras(): если canvas_region
        пуст, зону задают dst_points. Иначе схема назначения на экране линкера
        осталась бы пустой там, где склейка прекрасно работает.
    */
    static cv::Rect region_of(const FProjectionCamera& cam) {
        const auto& pts = !cam.canvas_region.empty() ? cam.canvas_region : cam.dst_points;
        if (pts.empty()) return {};

        float min_x = pts[0].x, max_x = pts[0].x;
        float min_y = pts[0].y, max_y = pts[0].y;
        for (const auto& p : pts) {
            min_x = std::min(min_x, p.x);
            max_x = std::max(max_x, p.x);
            min_y = std::min(min_y, p.y);
            max_y = std::max(max_y, p.y);
        }

        return cv::Rect(
            cvRound(min_x),
            cvRound(min_y),
            cvRound(max_x - min_x),
            cvRound(max_y - min_y)
        );
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
        {
            std::lock_guard<std::mutex> preset_lk(m_active_preset_mutex);
            if (!m_active_preset) {
                error = "save_stitching_export(): no active projection preset";
                return false;
            }
            canvas_size = m_active_preset->canvas_size;
            cams_copy = m_active_preset->cameras;
            try {
                overlay_images = m_projection_config.serialize_images(m_active_preset->images);
            }
            catch (...) {
                m_logger.warn("save_stitching_export(): cannot serialize images from active preset!");
            }
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

        const std::filesystem::path id_dir = export_root / id;
        if (!std::filesystem::create_directories(id_dir)) {
            error = "save_stitching_export(): cannot create durectory at " + id_dir.string();
            return false;
        }

        // Перебираем камеры пресета и пишем те, для которых есть warp + extras.
        boost::json::object cameras_json;
        int exported = 0;

        for (const auto& [cam_key, cam] : cams_copy) {
            m_logger.debug("save_stitching_export(): processing camera <" + cam_key + ">");
            auto warp_it = m_warped_mats.find(cam_key);
            auto extras_it = m_warp_extras.find(cam_key);
            if (warp_it == m_warped_mats.end() || extras_it == m_warp_extras.end()) {
                m_logger.warn("save_stitching_export(): skip <" + cam_key + ">, no warp/extras");
                continue;
            }

            // 1) Композиция и нормализация в [0..1] по raw_size.
            cv::Mat remap_norm;  // CV_32FC2
            std::string error;

            m_logger.debug("save_stitching_export(): composing remap for <" + cam_key + ">");
            if (!compose_remap_to_raw(
                warp_it->second.first, warp_it->second.second,
                undist_x, undist_y,
                raw_size, remap_norm, error)
            ){
                m_logger.error("save_stitching_export(): compose failed for <" + cam_key + ">");
                continue;
            }

            m_logger.debug( 
                "save_stitching_export(): remap composed for <" + cam_key +">, size=" +
                std::to_string(remap_norm.cols) + "x" + std::to_string(remap_norm.rows)
            );

            // 2) Weight — конвертация float → uint8. Нормализуем по максимуму,
            //    чтобы динамический диапазон сохранился. Если максимум = 0 — пишем нули.
            cv::Mat weight_u8;
            {
                const cv::Mat& weight_f = extras_it->second.weight;
                double minv = 0, maxv = 0;
                cv::minMaxLoc(weight_f, &minv, &maxv);

                m_logger.debug(
                    "save_stitching_export(): weight range for <" + cam_key +
                    "> min=" + std::to_string(minv) +", max=" + std::to_string(maxv)
                );

                if (maxv > 0.0) {
                    weight_f.convertTo(weight_u8, CV_8UC1, 255.0 / maxv);
                }
                else {
                    weight_u8 = cv::Mat::zeros(weight_f.size(), CV_8UC1);
                }
            }

            // 3) Имена файлов (с префиксом-ключом камеры).
            const std::string remap_name = cam_key + "_remap.bin";
            const std::string weight_name = cam_key + "_weight.bin";

            const auto remap_path = id_dir / remap_name;
            const auto weight_path = id_dir / weight_name;

            if (!gl_maps::save_remap(remap_path, remap_norm)) {
                m_logger.error("save_stitching_export(): cannot write " + remap_path.string());
                continue;
            }
            if (!gl_maps::save_weight(weight_path, weight_u8)) {
                m_logger.error("save_stitching_export(): cannot write " + weight_path.string());
                continue;
            }

            // 4) Запись в JSON — пути относительно export_root.
            boost::json::object cam_obj;
            cam_obj["remap"] = (std::filesystem::path(id) / remap_name).generic_string();
            cam_obj["weight"] = (std::filesystem::path(id) / weight_name).generic_string();

            // Место камеры на канвасе прямоугольником: по нему линкер рисует схему
            // назначения. Считаем здесь, а не на клиенте, потому что полигоны
            // за пределы этого файла не выходят.
            cv::Rect region = region_of(cam);
            if (region.width > 0 && region.height > 0) {
                boost::json::array r;
                r.emplace_back(region.x);
                r.emplace_back(region.y);
                r.emplace_back(region.width);
                r.emplace_back(region.height);
                cam_obj["region"] = std::move(r);
            }
            else {
                m_logger.warn("save_stitching_export(): no region for <" + cam_key + ">");
            }

            cameras_json[cam_key] = std::move(cam_obj);
            ++exported;

            m_logger.info("save_stitching_export(): exported camera <" + cam_key + ">");
        }

        if (exported == 0) {
            m_logger.error("save_stitching_export(): nothing exported");
            return false;
        }

        // 5) Обновляем общий json-индекс.
        boost::json::object record;
        record["name"] = display_name;
        record["width"] = canvas_size.width;
        record["height"] = canvas_size.height;
        record["cameras"] = std::move(cameras_json);
        record["images"] = overlay_images;

        const auto json_path = export_root / constants::LINKER_CONFIGURATION_INDEX;

        UJsonReaderBase* generic = nullptr;  // не наследник — нужен прямой доступ
        UJsonStitchingExports index(&m_logger);
        index.read(json_path);
        index.add_json_item(id, std::move(record));
        if (!index.save(json_path)) {
            m_logger.error("save_stitching_export(): cannot save index json " + json_path.string());
            return false;
        }

        m_logger.info("save_stitching_export(): exported " + std::to_string(exported) + " cameras under id <" + id + ">");
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
        if (!save_stitching_export(constants::LINKER_CONFIGURES_ROOT, id, display_name, error)) {
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

