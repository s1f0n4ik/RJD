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

    static void matmul_by_cpu_uint8(float* A, float* B, std::vector<uint8_t>& C, int ROWS_A, int COLS_A, int COLS_B)
    {
        float temp = 0;
        for (int i = 0; i < ROWS_A; i++)
        {
            for (int j = 0; j < COLS_B; j++)
            {
                temp = 0;
                for (int k = 0; k < COLS_A; k++)
                {
                    temp += A[i * COLS_A + k] * B[k * COLS_B + j];
                }
                C[i * COLS_B + j] = temp > 0 ? 4 : 0;
            }
        }
    }

    static void resize_by_opencv_uint8(uint8_t* input_image, int input_width, int input_height, int boxes_num, std::vector<uint8_t>& output_image, int target_width, int target_height)
    {
        for (int b = 0; b < boxes_num; b++)
        {
            cv::Mat src_image(input_height, input_width, CV_8U, &input_image[b * input_width * input_height]);
            cv::Mat dst_image;
            cv::resize(src_image, dst_image, cv::Size(target_width, target_height), 0, 0, cv::INTER_LINEAR);
            memcpy(&output_image[b * target_width * target_height], dst_image.data, target_width * target_height * sizeof(uint8_t));
        }
    }

    static void crop_mask_uint8(const std::vector<FDetection>& detections, uint8_t* seg_mask, int height, int width, std::vector<uint8_t>& all_mask_in_one)
    {
        for (size_t det_i = 0; det_i < detections.size(); ++det_i)
        {
            float x1 = detections[det_i].cropped_cords[0];
            float y1 = detections[det_i].cropped_cords[1];
            float x2 = detections[det_i].cropped_cords[2];
            float y2 = detections[det_i].cropped_cords[3];

            for (int i = 0; i < height; i++)
            {
                for (int j = 0; j < width; j++)
                {
                    if (j >= x1 && j < x2 && i >= y1 && i < y2)
                    {
                        if (all_mask_in_one[i * width + j] == 0)
                        {
                            all_mask_in_one[i * width + j] =
                                seg_mask[det_i * width * height + i * width + j] > 0 ? (detections[det_i].class_id + 1) : 0;
                        }
                    }
                }
            }
        }
    }

    static void seg_reverse(uint8_t* seg_mask, std::vector<uint8_t>& cropped_seg, int model_in_height, int model_in_width,
                           int cropped_height, int cropped_width, int ori_in_height, int ori_in_width, int y_pad, int x_pad,
                           std::vector<uint8_t>& seg_mask_real)
    {
        if (y_pad == 0 && x_pad == 0 && ori_in_height == model_in_height && ori_in_width == model_in_width)
        {
            return;
        }

        int cropped_index = 0;
        for (int i = 0; i < model_in_height; i++)
        {
            for (int j = 0; j < model_in_width; j++)
            {
                if (i >= y_pad && i < model_in_height - y_pad && j >= x_pad && j < model_in_width - x_pad)
                {
                    cropped_seg[cropped_index] = seg_mask[i * model_in_width + j];
                    cropped_index++;
                }
            }
        }
        resize_by_opencv_uint8(cropped_seg.data(), cropped_width, cropped_height, 1, seg_mask_real, ori_in_width, ori_in_height);
    }

    const char* output_layout_name(EOutputLayout layout)
    {
        switch (layout) {
        case EOutputLayout::SINGLE: return "single output [1, 4+nc, anchors]";
        case EOutputLayout::SPLIT_LEVELS: return "split levels (box, scores, sum) x3";
        case EOutputLayout::SEGMENTATION: return "int8 segmentation, proto + 3 levels";
        default: return "unknown";
        }
    }

    EOutputLayout detect_output_layout(const rknn_app_context_t& app_ctx, int& out_class_count)
    {
        out_class_count = 0;
        const uint32_t n = app_ctx.io_num.n_output;
        const rknn_tensor_attr* attrs = app_ctx.output_attrs;
        if (n == 0 || attrs == nullptr) {
            return EOutputLayout::UNKNOWN;
        }

        if (n == 1 && attrs[0].n_dims == 3 && attrs[0].dims[1] > 4 && attrs[0].dims[2] > 0) {
            out_class_count = static_cast<int>(attrs[0].dims[1]) - 4;
            return EOutputLayout::SINGLE;
        }

        if (n == 4 && app_ctx.is_quant) {
            // Прото-тензор имеет 32 канала, уровни сетки: 64 DFL + nc + 32 коэффициентов маски
            for (uint32_t i = 0; i < n; ++i) {
                if (attrs[i].n_dims == 4 && attrs[i].dims[1] > 64 + 32) {
                    out_class_count = static_cast<int>(attrs[i].dims[1]) - 64 - 32;
                    break;
                }
            }
            return EOutputLayout::SEGMENTATION;
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

    void decode_int8_segmentation(
        const rknn_app_context_t& app_ctx,
        const std::vector<rknn_output>& outputs,
        letterbox_t* letter_box,
        const input_parameters_t& input_parameters,
        std::vector<FDetection>& out_detections,
        segmentation_proto_t& out_proto
    )
    {
        const int class_count = usable_class_count(app_ctx, input_parameters);

        for (size_t output_index = 0; output_index < outputs.size(); output_index++) {
            const rknn_tensor_attr& output_attr = app_ctx.output_attrs[output_index];
            const int8_t* tensor = static_cast<int8_t*>(outputs[output_index].buf);

            int detection_data = output_attr.dims[1];
            int grid_height = output_attr.dims[2];
            int grid_width = output_attr.dims[3];

            int zero_point = output_attr.zp;
            float scale = output_attr.scale;

            if (detection_data == input_parameters.mask_coeffs_count) {
                out_proto.height = output_attr.dims[2];
                out_proto.width = output_attr.dims[3];
                out_proto.coefficients = input_parameters.mask_coeffs_count;

                int proto_tensor_size = out_proto.coefficients * out_proto.height * out_proto.width;
                out_proto.tensor.resize(proto_tensor_size);

                for (int p = 0; p < proto_tensor_size; ++p) {
                    out_proto.tensor[p] = dequantize(tensor[p], scale, zero_point);
                }
                continue;
            }

            float stride = input_parameters.model_width / grid_width;

            for (int y = 0; y < grid_height; ++y) {
                for (int x = 0; x < grid_width; ++x) {
                    int base_offset = y * grid_width + x;

                    int class_id = -1;
                    float max_class_conf = 0;

                    for (int c = 0; c < class_count; ++c) {
                        float value = dequantize(tensor[c * grid_height * grid_width + base_offset], scale, zero_point);

                        if (value > max_class_conf) {
                            max_class_conf = value;
                            class_id = c;
                        }
                    }

                    if (max_class_conf < input_parameters.threshold_confidence) {
                        continue;
                    }

                    std::vector<float> dfl(input_parameters.dfl_count);
                    std::vector<float> mask_coeffs(input_parameters.mask_coeffs_count);

                    int dfl_bins = input_parameters.dfl_count / 4;

                    // Каналы после классов: DFL, затем коэффициенты маски; классы считаются по тензору, не по конфигурации
                    const int model_classes = app_ctx.model_class_count;
                    for (int c = model_classes; c < detection_data; ++c) {
                        float value = dequantize(tensor[c * grid_height * grid_width + base_offset], scale, zero_point);

                        if (c < model_classes + input_parameters.dfl_count) {
                            dfl[c - model_classes] = value;
                        }
                        else {
                            mask_coeffs[c - (model_classes + input_parameters.dfl_count)] = value;
                        }
                    }
                    FDetection detect;

                    int num_cords = 4;
                    detect.cropped_cords.resize(num_cords);
                    for (int cord = 0; cord < num_cords; ++cord) {
                        int grid_temp = cord % 2 == 0 ? x : y;
                        int grid_coef = cord <= 1 ? -1 : 1;
                        detect.cropped_cords[cord] = (grid_temp + grid_coef * compute_dfl(&dfl[cord * dfl_bins], dfl_bins) + 0.5) * stride;
                    }

                    detect.x1_coord = static_cast<int>(std::clamp(detect.cropped_cords[0] - letter_box->x_pad, 0.f, (float)input_parameters.model_width) / letter_box->scale);
                    detect.y1_coord = static_cast<int>(std::clamp(detect.cropped_cords[1] - letter_box->y_pad, 0.f, (float)input_parameters.model_height) / letter_box->scale);
                    detect.x2_coord = static_cast<int>(std::clamp(detect.cropped_cords[2] - letter_box->x_pad, 0.f, (float)input_parameters.model_width) / letter_box->scale);
                    detect.y2_coord = static_cast<int>(std::clamp(detect.cropped_cords[3] - letter_box->y_pad, 0.f, (float)input_parameters.model_height) / letter_box->scale);

                    detect.confidence = max_class_conf;
                    detect.class_id = class_id;

                    detect.mask_coefficients = std::move(mask_coeffs);

                    out_detections.push_back(detect);
                }
            }
        }
    }

    void build_segmentation_mask(
        const std::vector<FDetection>& detections,
        const segmentation_proto_t& proto,
        letterbox_t* letter_box,
        const input_parameters_t& input_parameters,
        std::vector<uint8_t>& out_mask
    )
    {
        if (proto.empty() || detections.empty()) {
            return;
        }

        int mask_h = proto.height;
        int mask_w = proto.width;
        int num_coefficients = proto.coefficients;

        int count_detections = static_cast<int>(detections.size());
        std::vector<float> mask_coefficients;
        mask_coefficients.reserve(count_detections * num_coefficients);
        for (const auto& det : detections) {
            mask_coefficients.insert(mask_coefficients.end(), det.mask_coefficients.begin(), det.mask_coefficients.end());
        }

        // Копия прото-тензора: matmul_by_cpu_uint8 принимает неконстантный указатель
        std::vector<float> proto_tensor = proto.tensor;

        std::vector<uint8_t> matmul_result(count_detections * mask_h * mask_w);
        matmul_by_cpu_uint8(mask_coefficients.data(), proto_tensor.data(), matmul_result, count_detections, num_coefficients, mask_h * mask_w);

        std::vector<uint8_t> seg_mask(count_detections * input_parameters.model_width * input_parameters.model_height);
        resize_by_opencv_uint8(matmul_result.data(), mask_w, mask_h, count_detections, seg_mask, input_parameters.model_width, input_parameters.model_height);

        std::vector<uint8_t> all_mask_in_one(input_parameters.model_width * input_parameters.model_height);
        crop_mask_uint8(detections, seg_mask.data(), input_parameters.model_height, input_parameters.model_width, all_mask_in_one);

        int cropped_height = input_parameters.model_height - letter_box->y_pad * 2;
        int cropped_width = input_parameters.model_width - letter_box->x_pad * 2;
        int original_height = input_parameters.input_image_height;
        int original_width = input_parameters.input_image_width;
        int x_pad = letter_box->x_pad; int y_pad = letter_box->y_pad;

        std::vector<uint8_t> cropped_mask(cropped_height * cropped_width);
        out_mask.resize(input_parameters.input_image_height * input_parameters.input_image_width);
        seg_reverse(all_mask_in_one.data(), cropped_mask, input_parameters.model_height, input_parameters.model_width,
                    cropped_height, cropped_width, original_height, original_width, y_pad, x_pad, out_mask);
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
        std::vector<bool> used(Outputs.size(), false);
        float dfl[4 * DFL_BINS];

        for (size_t i = 0; i < Outputs.size(); ++i) {
            if (used[i] || app_ctx.output_attrs[i].dims[1] != 1) continue;

            // Тензор суммы задаёт уровень; бокс и скоры ищем по той же сетке
            const rknn_tensor_attr& sum_attr = app_ctx.output_attrs[i];
            const int grid_h = static_cast<int>(sum_attr.dims[2]);
            const int grid_w = static_cast<int>(sum_attr.dims[3]);
            int box_index = -1, cls_index = -1;
            for (size_t j = 0; j < Outputs.size(); ++j) {
                const rknn_tensor_attr& a = app_ctx.output_attrs[j];
                if (j == i || used[j] || a.dims[2] != sum_attr.dims[2] || a.dims[3] != sum_attr.dims[3]) continue;
                if (a.dims[1] == 4 || a.dims[1] == 4 * DFL_BINS) box_index = static_cast<int>(j);
                else if (a.dims[1] != 1) cls_index = static_cast<int>(j);
            }
            if (box_index < 0 || cls_index < 0) continue;
            used[i] = used[box_index] = used[cls_index] = true;

            const rknn_tensor_attr& box_attr = app_ctx.output_attrs[box_index];
            const int bins = static_cast<int>(box_attr.dims[1]) / 4;
            const size_t cells = static_cast<size_t>(grid_h) * grid_w;
            const float stride_x = static_cast<float>(input_parameters.model_width) / grid_w;
            const float stride_y = static_cast<float>(input_parameters.model_height) / grid_h;

            const FTensorReader sum(Outputs[i], sum_attr);
            const FTensorReader scores(Outputs[cls_index], app_ctx.output_attrs[cls_index]);
            const FTensorReader boxes(Outputs[box_index], box_attr);
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
                    OutDetections.push_back(make_detection(
                        (cx - left) * stride_x, (cy - top) * stride_y,
                        (cx + right) * stride_x, (cy + bottom) * stride_y,
                        class_id, score, LetterBox, input_parameters));
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
        if (Outputs.empty() || Outputs[0].buf == nullptr) return;

        const int classes = usable_class_count(app_ctx, input_parameters);
        if (classes <= 0) return;

        // Раскладка [1, channels, anchors]: якорей dims[2], у 3-мерного тензора dims[3] == 0
        const rknn_tensor_attr& attr = app_ctx.output_attrs[0];
        const size_t anchors = attr.dims[2];

        const FTensorReader reader(Outputs[0], attr);
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

            OutDetections.push_back(make_detection(
                cx - w * 0.5f, cy - h * 0.5f, cx + w * 0.5f, cy + h * 0.5f,
                class_id, score, LetterBox, input_parameters));
        }
    }

} // neural
} // varan
