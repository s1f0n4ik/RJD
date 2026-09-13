#pragma once

#include <vector>
#include <string>

#include "rknn_api.h"
#include "neural/common.h"
#include "neural/utility.h"
#include "neural/detection.h"
#include "image-utils.h"

#include "logger.h"

#define DFL_BINS 16

namespace varan {
namespace  neural {

    // Раскладка выходов модели, определяется один раз при загрузке по формам тензоров
    enum class EOutputLayout {
        UNKNOWN,
        // Один выход [1, 4 + nc, anchors]: боксы уже декодированы, скоры после сигмоиды (yolo26, yolo11 fp)
        SINGLE,
        // Девять выходов, на уровень: бокс [1, 4*bins, H, W], скоры после сигмоиды [1, nc, H, W], сумма скоров [1, 1, H, W]
        // bins 16 у yolo11 (DFL), 1 у yolo26 (расстояния напрямую)
        SPLIT_LEVELS,
        // Четыре выхода INT8: прото-тензор масок и три уровня сетки
        SEGMENTATION
    };

    const char* output_layout_name(EOutputLayout layout);

    typedef struct rknn_app_context {
        rknn_context rknn_ctx;
        rknn_input_output_num io_num;
        rknn_tensor_attr* input_attrs;
        rknn_tensor_attr* output_attrs;
        int model_channel;
        int model_width;
        int model_height;
        bool is_quant;
        EOutputLayout layout;
        // Число классов, зашитое в выходных тензорах; конфигурация с ним сверяется, но не переопределяет
        int model_class_count;
    } rknn_app_context_t;

    // Определяет раскладку по атрибутам выходов и число классов в модели
    EOutputLayout detect_output_layout(const rknn_app_context_t& app_ctx, int& out_class_count);

    // Всё, что нужно декодеру тензоров; NMS сюда не входит, его применяет вызывающий
    typedef struct FInputParameters {
        int input_image_width;
        int input_image_height;

        int model_width;
        int model_height;

        int dfl_count;
        int mask_coeffs_count;

        int class_count;

        float threshold_confidence;

    } input_parameters_t;

    // Прото-тензор масок, живёт между декодированием и сборкой маски
    struct FSegmentationProto {
        std::vector<float> tensor;

        int width = 0;
        int height = 0;
        int coefficients = 0;

        bool empty() const { return tensor.empty(); }
    };

    using segmentation_proto_t = FSegmentationProto;

    std::vector<FDetection> apply_nms(const std::vector<FDetection>& Detections, float IoU_Threshold);

    void decode_int8_segmentation(
        const rknn_app_context_t& app_ctx,
        const std::vector<rknn_output>& Outputs,
        letterbox_t* LetterBox,
        const input_parameters_t& input_parameters,
        std::vector<FDetection>& OutDetections,
        segmentation_proto_t& OutProto
    );

    // Собирает маску по детекциям, пережившим NMS
    void build_segmentation_mask(
        const std::vector<FDetection>& Detections,
        const segmentation_proto_t& Proto,
        letterbox_t* LetterBox,
        const input_parameters_t& input_parameters,
        std::vector<uint8_t>& out_mask
    );

    // Девять выходов по уровням; сумма скоров отбрасывает пустые якоря до чтения классов
    void decode_split_levels(
        const rknn_app_context_t& app_ctx,
        const std::vector<rknn_output>& Outputs,
        letterbox_t* LetterBox,
        const input_parameters_t& input_parameters,
        std::vector<FDetection>& OutDetections
    );

    // Одноголовый экспорт: выход [1, 4 + nc, anchors], каналы 0..3 — бокс, дальше скоры
    // Работает и с FP16/FP32, и с INT8
    void decode_single_output(
        const rknn_app_context_t& app_ctx,
        const std::vector<rknn_output>& Outputs,
        letterbox_t* LetterBox,
        const input_parameters_t& input_parameters,
        std::vector<FDetection>& OutDetections
    );

} // neural
} // varan
