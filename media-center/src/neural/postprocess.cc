#include "neural/postprocess.h"

#include <cstring>
#include <string>
#include <algorithm>
#include <cmath>
#include <opencv2/opencv.hpp>

namespace varan {
namespace  neural {

    static float dequantize(int8_t Quantized, float Scale, int ZeroPoint) {
        return (static_cast<float>(Quantized) - static_cast<float>(ZeroPoint)) * Scale;
    }

    inline static int __clip(float val, float min, float max)
    {
        float f = val <= min ? min : (val >= max ? max : val);
        return f;
    }

    static int8_t quantize_float(float input, int zero_point, float scale)
    {
        float dst_val = (input / scale) + zero_point;
        int8_t res = (int8_t)__clip(dst_val, -128, 127);
        return res;
    }

    // Координата из распределения DFL
    static float compute_dfl(const float* dfl_values, int bins)
    {
        std::vector<float> softmax_values(bins);
        float max_value = dfl_values[0];
        for (int i = 0; i < bins; i++) {
            if (dfl_values[i] > max_value) {
                max_value = dfl_values[i];
            }
        }

        float sum = 0.0f;
        for (int i = 0; i < bins; i++) {
            softmax_values[i] = std::exp(dfl_values[i] - max_value);
            sum += softmax_values[i];
        }
        for (int i = 0; i < bins; i++) {
            softmax_values[i] /= sum;
        }

        float result = 0.0f;
        for (int i = 0; i < bins; i++) {
            result += i * softmax_values[i];
        }

        return result;
    }

    static float compute_iou(const FDetection& Box1, const FDetection& Box2)
    {
        float inter_x1 = std::max(Box1.x1_coord, Box2.x1_coord);
        float inter_y1 = std::max(Box1.y1_coord, Box2.y1_coord);
        float inter_x2 = std::min(Box1.x2_coord, Box2.x2_coord);
        float inter_y2 = std::min(Box1.y2_coord, Box2.y2_coord);

        if (inter_x1 >= inter_x2 || inter_y1 >= inter_y2) {
            return 0.0f;
        }

        float inter_area = (inter_x2 - inter_x1) * (inter_y2 - inter_y1);
        float union_area = (Box1.y2_coord - Box1.y1_coord) * (Box1.x2_coord - Box1.x1_coord) + (Box2.y2_coord - Box2.y1_coord) * (Box2.x2_coord - Box2.x1_coord) - inter_area;

        return inter_area / union_area;
    }

    std::vector<FDetection> apply_nms(const std::vector<FDetection>& Detections, float IoU_Threshold)
    {
        std::vector<FDetection> sorted_detections = Detections;
        std::sort(sorted_detections.begin(), sorted_detections.end(),
            [](const FDetection& a, const FDetection& b) {
                return a.confidence > b.confidence;
            });

        std::vector<FDetection> selected_detections;
        std::vector<bool> suppress(Detections.size(), false);

        for (size_t i = 0; i < sorted_detections.size(); ++i) {
            if (suppress[i] == true) {
                continue;
            }

            selected_detections.push_back(sorted_detections[i]);

            for (size_t j = i + 1; j < sorted_detections.size(); ++j) {
                if (compute_iou(sorted_detections[i], sorted_detections[j]) > IoU_Threshold) {
                    suppress[j] = true;
                }
            }
        }

        return selected_detections;
    }

    // Индекс выхода по имени тензора; -1 — такого нет
    static int output_index(const rknn_app_context_t& app_ctx, const std::string& name)
    {
        for (uint32_t i = 0; i < app_ctx.io_num.n_output; ++i) {
            if (name == app_ctx.output_attrs[i].name) return static_cast<int>(i);
        }
        return -1;
    }

    // Головной выход одноголового экспорта: у seg рядом с ним лежит четырёхмерное прото
    static int head_index(const rknn_app_context_t& app_ctx)
    {
        return app_ctx.io_num.n_output == 2 && app_ctx.output_attrs[0].n_dims == 4 ? 1 : 0;
    }

    static int proto_index(const rknn_app_context_t& app_ctx)
    {
        if (app_ctx.layout == EOutputLayout::SPLIT_LEVELS_SEG) return output_index(app_ctx, "proto");
        return 1 - head_index(app_ctx);
    }

    // Выходы одного уровня сетки; seg только у seg-экспорта
    struct FLevel {
        int box = -1;
        int cls = -1;
        int sum = -1;
        int seg = -1;
    };

    // Уровни seg-экспорта по именам box_l*, cls_l*, sum_l*, seg_l*
    static std::vector<FLevel> named_levels(const rknn_app_context_t& app_ctx)
    {
        std::vector<FLevel> levels;
        for (int i = 0;; ++i) {
            const std::string tag = "_l" + std::to_string(i);
            const FLevel level{ output_index(app_ctx, "box" + tag), output_index(app_ctx, "cls" + tag),
                                output_index(app_ctx, "sum" + tag), output_index(app_ctx, "seg" + tag) };
            if (level.box < 0) break;
            levels.push_back(level);
        }
        return levels;
    }

    // Уровни девятитензорного экспорта: тензор суммы задаёт сетку, бокс и скоры ищутся по той же сетке
    static std::vector<FLevel> grid_levels(const rknn_app_context_t& app_ctx)
    {
        const uint32_t n = app_ctx.io_num.n_output;
        const rknn_tensor_attr* attrs = app_ctx.output_attrs;
        std::vector<FLevel> levels;
        std::vector<bool> used(n, false);
        for (uint32_t i = 0; i < n; ++i) {
            if (used[i] || attrs[i].dims[1] != 1) continue;
            FLevel level;
            level.sum = static_cast<int>(i);
            for (uint32_t j = 0; j < n; ++j) {
                const rknn_tensor_attr& a = attrs[j];
                if (j == i || used[j] || a.dims[2] != attrs[i].dims[2] || a.dims[3] != attrs[i].dims[3]) continue;
                if (a.dims[1] == 4 || a.dims[1] == 4 * DFL_BINS) level.box = static_cast<int>(j);
                else if (a.dims[1] != 1) level.cls = static_cast<int>(j);
            }
            if (level.box < 0 || level.cls < 0) continue;
            used[i] = used[level.box] = used[level.cls] = true;
            levels.push_back(level);
        }
        return levels;
    }

    const char* output_layout_name(EOutputLayout layout)
    {
        switch (layout) {
        case EOutputLayout::SINGLE: return "single output [1, 4+nc, anchors]";
        case EOutputLayout::SPLIT_LEVELS: return "split levels (box, scores, sum) x3";
        case EOutputLayout::SINGLE_SEG: return "single output with masks [1, 4+nc+nm, anchors] + proto";
        case EOutputLayout::SPLIT_LEVELS_SEG: return "split levels with masks (box, scores, sum, mask) x3 + proto";
        default: return "unknown";
        }
    }

    EOutputLayout detect_output_layout(const rknn_app_context_t& app_ctx, int& out_class_count, int& out_mask_count)
    {
        out_class_count = 0;
        out_mask_count = 0;
        const uint32_t n = app_ctx.io_num.n_output;
        const rknn_tensor_attr* attrs = app_ctx.output_attrs;
        if (n == 0 || attrs == nullptr) {
            return EOutputLayout::UNKNOWN;
        }

        if (n == 1 && attrs[0].n_dims == 3 && attrs[0].dims[1] > 4 && attrs[0].dims[2] > 0) {
            out_class_count = static_cast<int>(attrs[0].dims[1]) - 4;
            return EOutputLayout::SINGLE;
        }

        if (n == 2) {
            const rknn_tensor_attr& head = attrs[head_index(app_ctx)];
            const rknn_tensor_attr& proto = attrs[proto_index(app_ctx)];
            const int classes = static_cast<int>(head.dims[1]) - 4 - static_cast<int>(proto.dims[1]);
            if (head.n_dims != 3 || proto.n_dims != 4 || head.dims[2] == 0 || classes <= 0) {
                return EOutputLayout::UNKNOWN;
            }
            out_class_count = classes;
            out_mask_count = static_cast<int>(proto.dims[1]);
            return EOutputLayout::SINGLE_SEG;
        }

        const int proto = output_index(app_ctx, "proto");
        if (proto >= 0) {
            const auto levels = named_levels(app_ctx);
            if (levels.empty() || n != levels.size() * 4 + 1) {
                return EOutputLayout::UNKNOWN;
            }
            for (const auto& level : levels) {
                if (level.cls < 0 || level.sum < 0 || level.seg < 0) return EOutputLayout::UNKNOWN;
            }
            out_class_count = static_cast<int>(attrs[levels[0].cls].dims[1]);
            out_mask_count = static_cast<int>(attrs[proto].dims[1]);
            return EOutputLayout::SPLIT_LEVELS_SEG;
        }

        if (n == 9) {
            // Три уровня по три тензора одной сетки: бокс (каналов кратно 4), скоры (nc), сумма (1)
            int scores = -1;
            for (uint32_t i = 0; i < n; ++i) {
                if (attrs[i].n_dims != 4 || attrs[i].dims[2] == 0 || attrs[i].dims[3] == 0) {
                    return EOutputLayout::UNKNOWN;
                }
            }
            for (uint32_t i = 0; i < n; ++i) {
                int box = 0, cls = 0, sum = 0;
                for (uint32_t j = 0; j < n; ++j) {
                    if (attrs[j].dims[2] != attrs[i].dims[2] || attrs[j].dims[3] != attrs[i].dims[3]) continue;
                    const uint32_t channels = attrs[j].dims[1];
                    if (channels == 1) ++sum;
                    else if (channels == 4 || channels == 4 * DFL_BINS) ++box;
                    else { ++cls; if (scores < 0) scores = static_cast<int>(channels); else if (scores != static_cast<int>(channels)) return EOutputLayout::UNKNOWN; }
                }
                if (box != 1 || cls != 1 || sum != 1) {
                    return EOutputLayout::UNKNOWN;
                }
            }
            out_class_count = scores;
            return EOutputLayout::SPLIT_LEVELS;
        }

        return EOutputLayout::UNKNOWN;
    }

    namespace {

        // Чтение значения из выхода: INT8 деквантуется по своим zp и scale, остальное уже float
        struct FTensorReader {
            const int8_t* q = nullptr;
            const float* f = nullptr;
            bool is_int8 = false;
            int zp = 0;
            float scale = 1.f;

            FTensorReader(const rknn_output& output, const rknn_tensor_attr& attr)
            {
                is_int8 = attr.type == RKNN_TENSOR_INT8;
                zp = attr.zp;
                scale = attr.scale;
                q = static_cast<const int8_t*>(output.buf);
                f = static_cast<const float*>(output.buf);
            }

            float at(size_t idx) const
            {
                return is_int8 ? dequantize(q[idx], scale, zp) : f[idx];
            }

            // Порог в квантованном виде: сравнение без деквантования всего тензора
            int8_t quantized_threshold(float threshold) const
            {
                return quantize_float(threshold, zp, scale);
            }

            // Лучший класс среди каналов [first, first + count) для якоря anchor при шаге stride между каналами
            // Возвращает false, если ни один класс не дотянул до порога
            bool best_class(size_t first, int count, size_t anchor, size_t stride,
                            float threshold, int8_t q_threshold, int& class_id, float& score) const
            {
                class_id = -1;
                score = 0.f;
                if (is_int8) {
                    int best = static_cast<int>(q_threshold) - 1;
                    for (int c = 0; c < count; ++c) {
                        const int v = q[(first + c) * stride + anchor];
                        if (v > best) {
                            best = v;
                            class_id = c;
                        }
                    }
                    if (class_id < 0) return false;
                    score = dequantize(static_cast<int8_t>(best), scale, zp);
                    return true;
                }
                for (int c = 0; c < count; ++c) {
                    const float v = f[(first + c) * stride + anchor];
                    if (v > score) {
                        score = v;
                        class_id = c;
                    }
                }
                return class_id >= 0 && score >= threshold;
            }
        };

        // Бокс из координат входа модели в координаты исходного кадра
        FDetection make_detection(float x1, float y1, float x2, float y2, int class_id, float score,
                                  const letterbox_t* letter_box, const input_parameters_t& params)
        {
            FDetection detect;
            const float w = static_cast<float>(params.model_width);
            const float h = static_cast<float>(params.model_height);
            detect.x1_coord = static_cast<int>(std::clamp(x1 - letter_box->x_pad, 0.f, w) / letter_box->scale);
            detect.y1_coord = static_cast<int>(std::clamp(y1 - letter_box->y_pad, 0.f, h) / letter_box->scale);
            detect.x2_coord = static_cast<int>(std::clamp(x2 - letter_box->x_pad, 0.f, w) / letter_box->scale);
            detect.y2_coord = static_cast<int>(std::clamp(y2 - letter_box->y_pad, 0.f, h) / letter_box->scale);
            detect.confidence = score;
            detect.class_id = class_id;
            return detect;
        }

        // Сколько классов разбирать: не больше, чем описано в конфигурации
        int usable_class_count(const rknn_app_context_t& app_ctx, const input_parameters_t& params)
        {
            return std::min(app_ctx.model_class_count, params.class_count);
        }
    }

    void decode_split_levels(
        const rknn_app_context_t& app_ctx,
        const std::vector<rknn_output>& Outputs,
        letterbox_t* LetterBox,
        const input_parameters_t& input_parameters,
        std::vector<FDetection>& OutDetections
    )
    {
        const int classes = usable_class_count(app_ctx, input_parameters);
        if (classes <= 0) return;

        const float threshold = input_parameters.threshold_confidence;
        const int masks = app_ctx.mask_count;
        float dfl[4 * DFL_BINS];

        const auto levels = app_ctx.layout == EOutputLayout::SPLIT_LEVELS_SEG ? named_levels(app_ctx) : grid_levels(app_ctx);
        for (const auto& level : levels) {
            const rknn_tensor_attr& sum_attr = app_ctx.output_attrs[level.sum];
            const int grid_h = static_cast<int>(sum_attr.dims[2]);
            const int grid_w = static_cast<int>(sum_attr.dims[3]);

            const rknn_tensor_attr& box_attr = app_ctx.output_attrs[level.box];
            const int bins = static_cast<int>(box_attr.dims[1]) / 4;
            const size_t cells = static_cast<size_t>(grid_h) * grid_w;
            const float stride_x = static_cast<float>(input_parameters.model_width) / grid_w;
            const float stride_y = static_cast<float>(input_parameters.model_height) / grid_h;

            const FTensorReader sum(Outputs[level.sum], sum_attr);
            const FTensorReader scores(Outputs[level.cls], app_ctx.output_attrs[level.cls]);
            const FTensorReader boxes(Outputs[level.box], box_attr);
            const int8_t q_sum_threshold = sum.quantized_threshold(threshold);
            const int8_t q_threshold = scores.quantized_threshold(threshold);

            for (int y = 0; y < grid_h; ++y) {
                for (int x = 0; x < grid_w; ++x) {
                    const size_t cell = static_cast<size_t>(y) * grid_w + x;

                    // Сумма скоров ниже порога: ни один класс его не превысит
                    if (sum.is_int8 ? sum.q[cell] < q_sum_threshold : sum.f[cell] < threshold) continue;

                    int class_id;
                    float score;
                    if (!scores.best_class(0, classes, cell, cells, threshold, q_threshold, class_id, score)) continue;

                    float left, top, right, bottom;
                    if (bins == DFL_BINS) {
                        for (int k = 0; k < 4 * DFL_BINS; ++k) {
                            dfl[k] = boxes.at(static_cast<size_t>(k) * cells + cell);
                        }
                        left = compute_dfl(dfl, DFL_BINS);
                        top = compute_dfl(dfl + DFL_BINS, DFL_BINS);
                        right = compute_dfl(dfl + 2 * DFL_BINS, DFL_BINS);
                        bottom = compute_dfl(dfl + 3 * DFL_BINS, DFL_BINS);
                    }
                    else {
                        // yolo26: расстояния до сторон в клетках сетки без DFL
                        left = boxes.at(cell);
                        top = boxes.at(cells + cell);
                        right = boxes.at(2 * cells + cell);
                        bottom = boxes.at(3 * cells + cell);
                    }

                    const float cx = x + 0.5f;
                    const float cy = y + 0.5f;
                    FDetection detection = make_detection(
                        (cx - left) * stride_x, (cy - top) * stride_y,
                        (cx + right) * stride_x, (cy + bottom) * stride_y,
                        class_id, score, LetterBox, input_parameters);

                    if (level.seg >= 0) {
                        const FTensorReader coefficients(Outputs[level.seg], app_ctx.output_attrs[level.seg]);
                        detection.mask_coefficients.resize(masks);
                        for (int k = 0; k < masks; ++k) {
                            detection.mask_coefficients[k] = coefficients.at(static_cast<size_t>(k) * cells + cell);
                        }
                    }
                    OutDetections.push_back(std::move(detection));
                }
            }
        }
    }

    void decode_single_output(
        const rknn_app_context_t& app_ctx,
        const std::vector<rknn_output>& Outputs,
        letterbox_t* LetterBox,
        const input_parameters_t& input_parameters,
        std::vector<FDetection>& OutDetections
    )
    {
        const int head = head_index(app_ctx);
        if (Outputs.size() <= static_cast<size_t>(head) || Outputs[head].buf == nullptr) return;

        const int classes = usable_class_count(app_ctx, input_parameters);
        if (classes <= 0) return;

        // Раскладка [1, channels, anchors]: якорей dims[2], у 3-мерного тензора dims[3] == 0
        const rknn_tensor_attr& attr = app_ctx.output_attrs[head];
        const size_t anchors = attr.dims[2];
        // Коэффициенты маски идут после всех классов модели, а не только описанных в конфигурации
        const size_t first_mask = 4 + static_cast<size_t>(app_ctx.model_class_count);

        const FTensorReader reader(Outputs[head], attr);
        const float threshold = input_parameters.threshold_confidence;
        const int8_t q_threshold = reader.quantized_threshold(threshold);

        for (size_t anchor = 0; anchor < anchors; ++anchor) {
            int class_id;
            float score;
            if (!reader.best_class(4, classes, anchor, anchors, threshold, q_threshold, class_id, score)) continue;

            // Бокс приходит центром и размерами в пикселях входа модели
            const float cx = reader.at(anchor);
            const float cy = reader.at(anchors + anchor);
            const float w = reader.at(2 * anchors + anchor);
            const float h = reader.at(3 * anchors + anchor);

            FDetection detection = make_detection(
                cx - w * 0.5f, cy - h * 0.5f, cx + w * 0.5f, cy + h * 0.5f,
                class_id, score, LetterBox, input_parameters);

            detection.mask_coefficients.resize(app_ctx.mask_count);
            for (int k = 0; k < app_ctx.mask_count; ++k) {
                detection.mask_coefficients[k] = reader.at((first_mask + k) * anchors + anchor);
            }
            OutDetections.push_back(std::move(detection));
        }
    }

    void build_polygons(
        const rknn_app_context_t& app_ctx,
        const std::vector<rknn_output>& Outputs,
        letterbox_t* LetterBox,
        const input_parameters_t& input_parameters,
        std::vector<FDetection>& Detections
    )
    {
        // Кусок контура меньше этой доли рамки — крапинка, не часть объекта
        constexpr double kMinPartArea = 0.02;
        // Допуск упрощения контура — доля диагонали рамки
        constexpr double kSimplify = 0.01;

        const int masks = app_ctx.mask_count;
        const int index = proto_index(app_ctx);
        if (masks <= 0 || index < 0 || static_cast<size_t>(index) >= Outputs.size() || Outputs[index].buf == nullptr) return;

        const rknn_tensor_attr& attr = app_ctx.output_attrs[index];
        const int proto_h = static_cast<int>(attr.dims[2]);
        const int proto_w = static_cast<int>(attr.dims[3]);
        const size_t plane = static_cast<size_t>(proto_h) * proto_w;
        const FTensorReader proto(Outputs[index], attr);

        // Клетка прото в пикселях входа модели
        const float cell_w = static_cast<float>(input_parameters.model_width) / proto_w;
        const float cell_h = static_cast<float>(input_parameters.model_height) / proto_h;
        const float scale = LetterBox->scale;
        const float pad_x = static_cast<float>(LetterBox->x_pad);
        const float pad_y = static_cast<float>(LetterBox->y_pad);

        for (auto& d : Detections) {
            if (static_cast<int>(d.mask_coefficients.size()) != masks) continue;

            // Рамка во входе модели и покрывающий её кусок прото
            const float mx1 = d.x1_coord * scale + pad_x, my1 = d.y1_coord * scale + pad_y;
            const float mx2 = d.x2_coord * scale + pad_x, my2 = d.y2_coord * scale + pad_y;
            const int px1 = std::clamp(static_cast<int>(std::floor(mx1 / cell_w)), 0, proto_w);
            const int py1 = std::clamp(static_cast<int>(std::floor(my1 / cell_h)), 0, proto_h);
            const int px2 = std::clamp(static_cast<int>(std::ceil(mx2 / cell_w)), 0, proto_w);
            const int py2 = std::clamp(static_cast<int>(std::ceil(my2 / cell_h)), 0, proto_h);

            if (px2 > px1 && py2 > py1) {
                // Логит маски = коэффициенты × прото; > 0 то же, что сигмоида > 0.5
                cv::Mat logits(py2 - py1, px2 - px1, CV_32F, cv::Scalar(0));
                for (int k = 0; k < masks; ++k) {
                    const float c = d.mask_coefficients[k];
                    const size_t base = static_cast<size_t>(k) * plane;
                    for (int y = py1; y < py2; ++y) {
                        float* row = logits.ptr<float>(y - py1);
                        const size_t offset = base + static_cast<size_t>(y) * proto_w;
                        for (int x = px1; x < px2; ++x) row[x - px1] += c * proto.at(offset + x);
                    }
                }

                cv::Mat up;
                cv::resize(logits, up, cv::Size(static_cast<int>(std::lround((px2 - px1) * cell_w)),
                                                static_cast<int>(std::lround((py2 - py1) * cell_h))), 0, 0, cv::INTER_LINEAR);
                const float ox = px1 * cell_w;
                const float oy = py1 * cell_h;
                const cv::Rect box = cv::Rect(static_cast<int>(std::lround(mx1 - ox)), static_cast<int>(std::lround(my1 - oy)),
                                              static_cast<int>(std::lround(mx2 - mx1)), static_cast<int>(std::lround(my2 - my1)))
                                     & cv::Rect(0, 0, up.cols, up.rows);

                if (!box.empty()) {
                    const cv::Mat binary = up(box) > 0.f;
                    std::vector<std::vector<cv::Point>> contours;
                    cv::findContours(binary, contours, cv::RETR_EXTERNAL, cv::CHAIN_APPROX_SIMPLE);

                    const double min_area = kMinPartArea * box.area();
                    const double epsilon = std::max(1.0, kSimplify * std::hypot(box.width, box.height));
                    const float bx = ox + box.x - pad_x;
                    const float by = oy + box.y - pad_y;
                    for (auto& contour : contours) {
                        if (cv::contourArea(contour) < min_area) continue;
                        std::vector<cv::Point> polygon;
                        cv::approxPolyDP(contour, polygon, epsilon, true);
                        // Из куска во входе модели в кадр, как рамка в make_detection
                        for (auto& p : polygon) {
                            p.x = std::clamp(static_cast<int>(std::lround((bx + p.x) / scale)), 0, input_parameters.input_image_width);
                            p.y = std::clamp(static_cast<int>(std::lround((by + p.y) / scale)), 0, input_parameters.input_image_height);
                        }
                        d.polygons.push_back(std::move(polygon));
                    }
                }
            }
            std::vector<float>().swap(d.mask_coefficients);
        }
    }

} // neural
} // varan
