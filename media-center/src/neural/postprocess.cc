#include "neural/postprocess.h"

#include <cstring>
#include <string>
#include <algorithm>
#include <iostream>
#include <fstream>
#include <cmath>
#include <opencv2/opencv.hpp>

namespace varan {
namespace  neural {

    static std::vector<FDetection> apply_nms(const std::vector<FDetection>& Detections, float IoU_Threshold);

    static void matmul_by_cpu_uint8(float* A, float* B, std::vector<uint8_t>& C, int ROWS_A, int COLS_A, int COLS_B);

    static void resize_by_opencv_uint8(uint8_t* input_image, int input_width, int input_height, int boxes_num, std::vector<uint8_t>& output_image, int target_width, int target_height);

    static void crop_mask_uint8(const std::vector<FDetection>& detections, uint8_t* seg_mask, int height, int width, std::vector<uint8_t>& all_mask_in_one);

    static void seg_reverse(uint8_t* seg_mask, std::vector<uint8_t>& cropped_seg, int model_in_height, int model_in_width,
                           int cropped_height, int cropped_width, int ori_in_height, int ori_in_width, int y_pad, int x_pad,
                           std::vector<uint8_t>& seg_mask_real);

    static float dequantize(int8_t Quantized, float Scale, int ZeroPoint);

    static float compute_dfl(const float* dfl_values, int bins);

    static float compute_iou(const FDetection& Box1, const FDetection& Box2);

    inline static int __clip(float val, float min, float max);

    static int8_t quantize_float(float input, int zero_point, float scale);

    void run_postprocess_int8_segmentation(
        const rknn_context& ctx,
        const std::vector<rknn_output>& outputs,
        letterbox_t* letter_box,
        image_buffer_t* source_image,
        const input_parameters_t& input_parameters,
        std::vector<FDetection>& out_detections,
        std::vector<uint8_t>& out_mask
    )
    {
        std::vector<float> tensor_proto;
        int num_coefficients = input_parameters.mask_coeffs_count;
        int mask_w = 0, mask_h = 0;

        int class_count = static_cast<int>(input_parameters.classes.size());

        for (size_t output_index = 0; output_index < outputs.size(); output_index++) {
            rknn_tensor_attr output_attr;
            memset(&output_attr, 0, sizeof(output_attr));
            output_attr.index = output_index;
            int ret = rknn_query(ctx, RKNN_QUERY_OUTPUT_ATTR, &output_attr, sizeof(output_attr));
            if (ret != RKNN_SUCC) {
                std::cerr << "Output tensor attributes request error " << output_index << ": " << ret << std::endl;
                continue;
            }

            const int8_t* tensor = static_cast<int8_t*>(outputs[output_index].buf);

            int detection_data = output_attr.dims[1];
            int grid_height = output_attr.dims[2];
            int grid_width = output_attr.dims[3];

            int zero_point = output_attr.zp;
            float scale = output_attr.scale;

            if (detection_data == input_parameters.mask_coeffs_count) {
                mask_h = output_attr.dims[2];
                mask_w = output_attr.dims[3];
                int proto_tensor_size = input_parameters.mask_coeffs_count * mask_h * mask_w;
                tensor_proto.resize(proto_tensor_size);

                for (int p = 0; p < proto_tensor_size; ++p) {
                    tensor_proto[p] = dequantize(tensor[p], scale, zero_point);
                }
            }
            else {
                float stride = input_parameters.model_width / grid_width;
                int grid_size = std::sqrt(grid_height * grid_width);

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


                        for (int c = class_count; c < detection_data; ++c) {
                            float value = dequantize(tensor[c * grid_height * grid_width + base_offset], scale, zero_point);

                            if (c < class_count + input_parameters.dfl_count) {
                                dfl[c - class_count] = value;
                            }
                            else {
                                mask_coeffs[c - (class_count + input_parameters.dfl_count)] = value;
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
        // После получения всех обнаружений работаем с дальнейшим постпроцессом
        out_detections = apply_nms(out_detections, input_parameters.threshold_nms);

        // Проверка, что есть прото тензор
        if (tensor_proto.empty()) {
            return;
        }

        int count_detections = out_detections.size();
        std::vector<float> mask_coefficients;
        mask_coefficients.reserve(count_detections* num_coefficients);
        for (const auto& det : out_detections) {
            mask_coefficients.insert(mask_coefficients.end(), det.mask_coefficients.begin(), det.mask_coefficients.end());
        }

        // Подсчет линейной комбинации для всех обнаружений по коэффициентам
        std::vector<uint8_t> matmul_result(count_detections * mask_h * mask_w);
        matmul_by_cpu_uint8(mask_coefficients.data(), tensor_proto.data(), matmul_result, count_detections, num_coefficients, mask_h * mask_w);

        // Вычисление маски по всему изображению
        std::vector<uint8_t> seg_mask(count_detections * input_parameters.model_width * input_parameters.model_height);
        resize_by_opencv_uint8(matmul_result.data(), mask_w, mask_h, count_detections, seg_mask, input_parameters.model_width, input_parameters.model_height);

        // Обрезка маски по боксам обнаружения
        std::vector<uint8_t> all_mask_in_one(input_parameters.model_width * input_parameters.model_height);
        crop_mask_uint8(out_detections, seg_mask.data(), input_parameters.model_height, input_parameters.model_width, all_mask_in_one);

        // Получение маски для реального изображения
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

    void run_postprocess_int8_format_3(
        const rknn_context& ctx,
        const std::vector<rknn_output>& outputs,
        letterbox_t* letter_box,
        image_buffer_t* source_image,
        const input_parameters_t& input_parameters,
        std::vector<FDetection>& out_detections
    )
    {
        std::vector<FDetection> attachment_detections;
        std::vector<FDetection> cargo_detections;

        for (size_t i = 0; i < outputs.size(); i++) 
        {
            // Устанавливаем параметры zero_point и scale
            rknn_tensor_attr output_attr;
            memset(&output_attr, 0, sizeof(output_attr));
            output_attr.index = i;  // Указываем индекс тензора
            int ret = rknn_query(ctx, RKNN_QUERY_OUTPUT_ATTR, &output_attr, sizeof(output_attr));
            if (ret != RKNN_SUCC) {
                std::cerr << "Output tensor attributes request error " << i << ": " << ret << std::endl;
                continue;
            }

            const int8_t* tensor = static_cast<int8_t*>(outputs[i].buf);
            int num_elements = output_attr.dims[2] * output_attr.dims[3];
            int grid_size = std::sqrt(num_elements);
            int detection_data = output_attr.dims[1];
            float stride = input_parameters.model_width / grid_size;

            int class_count = input_parameters.classes.size();

            int zero_point = output_attr.zp;
            float scale = output_attr.scale;

            //std::cout << "Tensor name: " << output_attr.name << "; num_elements: " << num_elements <<
            //    "; detection_data: " << detection_data << "; scale: " << scale << "; zero point: " << zero_point << ";" << std::endl;

            // Проходим по всем элементам сетки
            for (int i = 0; i < num_elements; i++) {
                float max = 0;
                int class_id = 0;

                // Определяем класс объекта
                for (int j = detection_data - class_count; j < detection_data; j++) {
                    float prob = dequantize(tensor[i + j * num_elements], scale, zero_point);
                    if (max < prob) {
                        max = prob;
                        class_id = j - (detection_data - class_count);
                    }
                }
                // Если класс меньше, чем минимальное значение, то пропускаем дальнейшие действия
                if (max < input_parameters.threshold_confidence) {
                    continue;
                }

                int row = i / grid_size;
                int col = i % grid_size;

                float dfl_x[DFL_BINS];
                float dfl_y[DFL_BINS];
                float dfl_x2[DFL_BINS];
                float dfl_y2[DFL_BINS];

                // Определяем DFL координат
                for (int bin = 0; bin < 16; bin++) {
                    dfl_x[bin] = dequantize(tensor[i + bin * num_elements], scale, zero_point);
                    dfl_y[bin] = dequantize(tensor[i + (DFL_BINS + bin) * num_elements], scale, zero_point);
                    dfl_x2[bin] = dequantize(tensor[i + (DFL_BINS * 2 + bin) * num_elements], scale, zero_point);
                    dfl_y2[bin] = dequantize(tensor[i + (DFL_BINS * 3 + bin) * num_elements], scale, zero_point);
                }

                FDetection detect;

                // Вычисляем конечные координаты 
                float result_dfl_x1 = (col - compute_dfl(dfl_x, DFL_BINS) + 0.5) * stride - letter_box->x_pad;
                float result_dfl_y1 = (row - compute_dfl(dfl_y, DFL_BINS) + 0.5) * stride - letter_box->y_pad;
                float result_dfl_x2 = (col + compute_dfl(dfl_x2, DFL_BINS) + 0.5) * stride - letter_box->x_pad;
                float result_dfl_y2 = (row + compute_dfl(dfl_y2, DFL_BINS) + 0.5) * stride - letter_box->y_pad;

                detect.x1_coord = static_cast<int>(std::clamp(result_dfl_x1, 0.f, (float)input_parameters.model_width) / letter_box->scale);
                detect.y1_coord = static_cast<int>(std::clamp(result_dfl_y1, 0.f, (float)input_parameters.model_height) / letter_box->scale);
                detect.x2_coord = static_cast<int>(std::clamp(result_dfl_x2, 0.f, (float)input_parameters.model_width) / letter_box->scale);
                detect.y2_coord = static_cast<int>(std::clamp(result_dfl_y2, 0.f, (float)input_parameters.model_height) / letter_box->scale);

                detect.confidence = max;

                detect.class_id = class_id;

                out_detections.push_back(detect);
            }
        }
        // Приеняем NMS
        out_detections = apply_nms(out_detections, input_parameters.threshold_nms);
    }

    void run_postprocess_float32_format_3(
        const rknn_app_context_t& app_ctx,
        const std::vector<rknn_output>& Outputs,
        letterbox_t* LetterBox,
        image_buffer_t* SourceImage,
        int InputWidth,
        int InputHeight,
        int NumClasses,
        const float ThresholdNMS,
        const float ThresholdConfidence,
        std::vector<FDetection>& OutDetections
    )
    {
        for (size_t i = 0; i < Outputs.size(); i++) 
        {
            const float* tensor = static_cast<float*>(Outputs[i].buf);
            int num_elements = app_ctx.output_attrs->dims[2] * app_ctx.output_attrs->dims[3] / pow(4, i);
            int grid_size = std::sqrt(num_elements);
            int detection_data = app_ctx.output_attrs->dims[1];
            float stride = InputWidth / grid_size;
            std::cout << "Tensor: " << app_ctx.output_attrs->name << "; num_elements: " << num_elements << "; detection_data: " << detection_data << std::endl;
            // Проходим по всем элементам сетки
            for (int i = 0; i < num_elements; i++) {
                float max = 0;
                int class_id = 0;

                // Определяем класс объекта
                for (int j = detection_data - NumClasses; j < detection_data; j++) {
                    float prob = tensor[i + j * num_elements];
                    if (max < prob) {
                        max = prob;
                        class_id = j - (detection_data - NumClasses);
                    }
                }
                // Если класс меньше, чем минимальное значение, то пропускаем дальнейшие действия
                if (max < ThresholdConfidence) {
                    continue;
                }

                int row = i / grid_size;
                int col = i % grid_size;

                float dfl_x[DFL_BINS];
                float dfl_y[DFL_BINS];
                float dfl_x2[DFL_BINS];
                float dfl_y2[DFL_BINS];

                // Определяем DFL координат
                for (int bin = 0; bin < 16; bin++) {
                    dfl_x[bin] = tensor[i + (bin) * num_elements];
                    dfl_y[bin] = tensor[i + (DFL_BINS + bin) * num_elements];
                    dfl_x2[bin] = tensor[i + (DFL_BINS * 2 + bin) * num_elements];
                    dfl_y2[bin] = tensor[i + (DFL_BINS * 3 + bin) * num_elements];
                }

                FDetection detect;

                // Вычисляем конечные координаты 
                float result_dfl_x1 = (col - compute_dfl(dfl_x, DFL_BINS) + 0.5) * stride - LetterBox->x_pad;
                float result_dfl_y1 = (row - compute_dfl(dfl_y, DFL_BINS) + 0.5) * stride - LetterBox->y_pad;
                float result_dfl_x2 = (col + compute_dfl(dfl_x2, DFL_BINS) + 0.5) * stride - LetterBox->x_pad;
                float result_dfl_y2 = (row + compute_dfl(dfl_y2, DFL_BINS) + 0.5) * stride - LetterBox->y_pad;

                detect.x1_coord = static_cast<int>(std::clamp(result_dfl_x1, 0.f, (float)InputWidth) / LetterBox->scale);
                detect.y1_coord = static_cast<int>(std::clamp(result_dfl_y1, 0.f, (float)InputHeight) / LetterBox->scale);
                detect.x2_coord = static_cast<int>(std::clamp(result_dfl_x2, 0.f, (float)InputWidth) / LetterBox->scale);
                detect.y2_coord = static_cast<int>(std::clamp(result_dfl_y2, 0.f, (float)InputHeight) / LetterBox->scale);

                detect.confidence = max;

                detect.class_id = class_id;

                OutDetections.push_back(detect);
            }
        }

        // Приеняем NMS
        OutDetections = apply_nms(OutDetections, ThresholdNMS);
    }

    void run_postprocess_fp_format_1(
        const rknn_context& ctx,
        const std::vector<rknn_output>& outputs,
        letterbox_t* letter_box,
        const input_parameters_t& input_parameters,
        std::vector<FDetection>& out_detections,
        ULogger* logger)
    {
        if (outputs.empty()) {
            if (logger) logger->error("ultra_single: no outputs");
            return;
        }

        const int class_count = static_cast<int>(input_parameters.classes.size());
        const int per_anchor = 4 + class_count;

        rknn_tensor_attr attr;
        memset(&attr, 0, sizeof(attr));
        attr.index = 0;
        if (rknn_query(ctx, RKNN_QUERY_OUTPUT_ATTR, &attr, sizeof(attr)) != RKNN_SUCC) {
            if (logger) logger->error("ultra_single: query failed");
            return;
        }

        int anchors = 0;
        bool channels_first = true;

        if (attr.dims[1] == per_anchor) {
            anchors = attr.dims[2];
            channels_first = true;
        }
        else if (attr.dims[2] == per_anchor) {
            anchors = attr.dims[1];
            channels_first = false;
        }
        else {
            if (logger) logger->error("ultra_single: bad shape dims=[" +
                std::to_string(attr.dims[0]) + "," +
                std::to_string(attr.dims[1]) + "," +
                std::to_string(attr.dims[2]) + "], per_anchor=" +
                std::to_string(per_anchor));
            return;
        }

        const float* data = static_cast<const float*>(outputs[0].buf);

        auto val = [data, anchors, per_anchor, channels_first](int c, int a) -> float {
            return channels_first
                ? data[c * anchors + a]
                : data[a * per_anchor + c];
            };

        const float thr = input_parameters.threshold_confidence;
        const int model_w = input_parameters.model_width;
        const int model_h = input_parameters.model_height;
        const float lb_sc = letter_box->scale;
        const float lb_xp = static_cast<float>(letter_box->x_pad);
        const float lb_yp = static_cast<float>(letter_box->y_pad);

        out_detections.reserve(64);
        bool sample_logged = false;

        for (int a = 0; a < anchors; ++a) {
            // Класс — уже вероятность 0..1 (sigmoid встроен в граф).
            float max_conf = 0.0f;
            int   max_cls = -1;
            for (int c = 0; c < class_count; ++c) {
                const float p = val(4 + c, a);
                if (p > max_conf) { max_conf = p; max_cls = c; }
            }
            if (max_conf < thr) continue;

            // bbox — уже в пикселях модели.
            const float cx = val(0, a);
            const float cy = val(1, a);
            const float w = val(2, a);
            const float h = val(3, a);

            /*
            if (!sample_logged && logger) {
                logger->info("ultra_single sample: a=" + std::to_string(a) +
                    " box=(" + std::to_string(cx) + "," + std::to_string(cy) +
                    "," + std::to_string(w) + "," + std::to_string(h) + ")" +
                    " conf=" + std::to_string(max_conf) +
                    " cls=" + std::to_string(max_cls));
                sample_logged = true;
            }*/

            float x1 = cx - w * 0.5f;
            float y1 = cy - h * 0.5f;
            float x2 = cx + w * 0.5f;
            float y2 = cy + h * 0.5f;

            // Letterbox-обратка → координаты исходного кадра.
            x1 = std::clamp(x1 - lb_xp, 0.0f, (float)model_w) / lb_sc;
            y1 = std::clamp(y1 - lb_yp, 0.0f, (float)model_h) / lb_sc;
            x2 = std::clamp(x2 - lb_xp, 0.0f, (float)model_w) / lb_sc;
            y2 = std::clamp(y2 - lb_yp, 0.0f, (float)model_h) / lb_sc;
            if (x2 <= x1 || y2 <= y1) continue;

            FDetection det;
            det.x1_coord = (int)x1;
            det.y1_coord = (int)y1;
            det.x2_coord = (int)x2;
            det.y2_coord = (int)y2;
            det.confidence = max_conf;
            det.class_id = max_cls;
            out_detections.push_back(det);
        }

        out_detections = apply_nms(out_detections, input_parameters.threshold_nms);

        if (logger) logger->trace("ultra_single: " + std::to_string(out_detections.size()) + " after NMS");
    }

    // Преобразование int8 в float
    static float dequantize(int8_t Quantized, float Scale, int ZeroPoint) {
        return (static_cast<float>(Quantized) - static_cast<float>(ZeroPoint)) * Scale;
    }

    // Функция для вычисления координаты по DFL
    static float compute_dfl(const float* dfl_values, int bins)
    {
        // Находим максимальное значение DFL
        std::vector<float> softmax_values(bins);
        float max_value = dfl_values[0];
        for (int i = 0; i < bins; i++) {
            if (dfl_values[i] > max_value) {
                max_value = dfl_values[i];
            }
        }

        // Вычисляем softmax по DFL
        float sum = 0.0f;
        for (int i = 0; i < bins; i++) {
            softmax_values[i] = std::exp(dfl_values[i] - max_value);
            sum += softmax_values[i];
        }
        for (int i = 0; i < bins; i++) {
            softmax_values[i] /= sum;
        }

        // Вычисляем конечное значение координаты
        float result = 0.0f;
        for (int i = 0; i < bins; i++) {
            result += i * softmax_values[i];
        }

        return result;
    }

    // Функция для вычисления пересечения (IoU) двух прямоугольников
    static float compute_iou(const FDetection& Box1, const FDetection& Box2)
    {
        // Находим координаты пересечения
        float inter_x1 = std::max(Box1.x1_coord, Box2.x1_coord);
        float inter_y1 = std::max(Box1.y1_coord, Box2.y1_coord);
        float inter_x2 = std::min(Box1.x2_coord, Box2.x2_coord);
        float inter_y2 = std::min(Box1.y2_coord, Box2.y2_coord);

        // Если прямоугольники не пересекаются
        if (inter_x1 >= inter_x2 || inter_y1 >= inter_y2) {
            return 0.0f;
        }

        float inter_area = (inter_x2 - inter_x1) * (inter_y2 - inter_y1);
        float union_area = (Box1.y2_coord - Box1.y1_coord) * (Box1.x2_coord - Box1.x1_coord) + (Box2.y2_coord - Box2.y1_coord) * (Box2.x2_coord - Box2.x1_coord) - inter_area;

        // IoU = площадь пересечения / площадь объединения
        return inter_area / union_area;
    }

    static std::vector<FDetection> apply_nms(const std::vector<FDetection>& Detections, float IoU_Threshold)
    {
        // Сортировка объектов по убыванию уверенности
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

            // Удаляем все объекты, которые сильно перекрываются с текущим
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
                if (temp > 0)
                {
                    C[i * COLS_B + j] = 4;
                }
                else
                {
                    C[i * COLS_B + j] = 0;
                }
            }
        }
    }

    void resize_by_opencv_uint8(uint8_t* input_image, int input_width, int input_height, int boxes_num, std::vector<uint8_t>& output_image, int target_width, int target_height)
    {
        for (int b = 0; b < boxes_num; b++)
        {
            cv::Mat src_image(input_height, input_width, CV_8U, &input_image[b * input_width * input_height]);
            cv::Mat dst_image;
            cv::resize(src_image, dst_image, cv::Size(target_width, target_height), 0, 0, cv::INTER_LINEAR);
            memcpy(&output_image[b * target_width * target_height], dst_image.data, target_width * target_height * sizeof(uint8_t));
        }
    }

    void crop_mask_uint8(const std::vector<FDetection>& detections, uint8_t* seg_mask, int height, int width, std::vector<uint8_t>& all_mask_in_one)
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
                            if (seg_mask[det_i * width * height + i * width + j] > 0)
                            {
                                all_mask_in_one[i * width + j] = (detections[det_i].class_id + 1);
                            }
                            else
                            {
                                all_mask_in_one[i * width + j] = 0;
                            }
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
                    int seg_index = i * model_in_width + j;
                    cropped_seg[cropped_index] = seg_mask[seg_index];
                    cropped_index++;
                }
            }
        }
        resize_by_opencv_uint8(cropped_seg.data(), cropped_width, cropped_height, 1, seg_mask_real, ori_in_width, ori_in_height);
        // resize_by_rga_rk356x(cropped_seg, cropped_width, cropped_height, seg_mask_real, ori_in_width, ori_in_height);
        // resize_by_rga_rk3588(cropped_seg, cropped_width, cropped_height, seg_mask_real, ori_in_width, ori_in_height);
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

} // neural
} // varan