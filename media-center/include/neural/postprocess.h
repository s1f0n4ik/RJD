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
        // SINGLE с коэффициентами масок: [1, 4 + nc + nm, anchors] и прото [1, nm, H/4, W/4]
        SINGLE_SEG,
        // SPLIT_LEVELS с четвёртым тензором уровня seg_l* [1, nm, H, W] и прото; выходы узнаются по именам
        SPLIT_LEVELS_SEG
    };

    inline bool is_segmentation(EOutputLayout layout) {
        return layout == EOutputLayout::SINGLE_SEG || layout == EOutputLayout::SPLIT_LEVELS_SEG;
    }

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
        // Коэффициентов маски на детекцию; 0 у моделей без масок
        int mask_count;
    } rknn_app_context_t;

    // Определяет раскладку по атрибутам выходов, число классов и коэффициентов маски
    EOutputLayout detect_output_layout(const rknn_app_context_t& app_ctx, int& out_class_count, int& out_mask_count);

    // Всё, что нужно декодеру тензоров; NMS сюда не входит, его применяет вызывающий
    typedef struct FInputParameters {
        int input_image_width;
        int input_image_height;

        int model_width;
        int model_height;

        int class_count;

        float threshold_confidence;

    } input_parameters_t;

    std::vector<FDetection> apply_nms(const std::vector<FDetection>& Detections, float IoU_Threshold);

    // Контуры масок по прото для детекций, переживших NMS; коэффициенты после сборки освобождаются
    void build_polygons(
        const rknn_app_context_t& app_ctx,
        const std::vector<rknn_output>& Outputs,
        letterbox_t* LetterBox,
        const input_parameters_t& input_parameters,
        std::vector<FDetection>& Detections
    );

    // Девять выходов по уровням (у seg тринадцать); сумма скоров отбрасывает пустые якоря до чтения классов
    void decode_split_levels(
        const rknn_app_context_t& app_ctx,
        const std::vector<rknn_output>& Outputs,
        letterbox_t* LetterBox,
        const input_parameters_t& input_parameters,
        std::vector<FDetection>& OutDetections
    );

    // Одноголовый экспорт: выход [1, 4 + nc, anchors], каналы 0..3 — бокс, дальше скоры, у seg затем коэффициенты маски
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
