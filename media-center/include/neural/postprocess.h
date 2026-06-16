#include <vector>
#include <string>
#include <map>

#include "rknn_api.h"
#include "neural/common.h"
#include "neural/utility.h"
#include "image-utils.h"

#include "logger.h"

#define DFL_BINS 16

namespace varan {
namespace  neural {
        
    typedef struct rknn_app_context {
        rknn_context rknn_ctx;
        rknn_input_output_num io_num;
        rknn_tensor_attr* input_attrs;
        rknn_tensor_attr* output_attrs;
        int model_channel;
        int model_width;
        int model_height;
        bool is_quant;
    } rknn_app_context_t;

    typedef struct FInputParameters {
        int input_image_width;
        int input_image_height;

        int model_width;
        int model_height;

        int dfl_count;
        int mask_coeffs_count;

        float threshold_nms;
        float threshold_confidence;

        const std::vector<FClassInfo>& classes;

    } input_parameters_t;

    struct FDetection
    {
        int x1_coord;
        int y1_coord;
        int x2_coord;
        int y2_coord;
        float confidence;

        int class_id;

        std::vector<float> mask_coefficients;
        std::vector<float> cropped_cords;
    };

    void run_postprocess_int8_segmentation(
        const rknn_context& ctx,
        const std::vector<rknn_output>& Outputs,
        letterbox_t* LetterBox,
        image_buffer_t* SourceImage,
        const input_parameters_t& input_parameters,
        std::vector<FDetection>& OutDetections,
        std::vector<uint8_t>& out_mask
    );

    void run_postprocess_int8_format_3(
        const rknn_context& ctx,
        const std::vector<rknn_output>& Outputs,
        letterbox_t* LetterBox,
        image_buffer_t* SourceImage,
        const input_parameters_t& input_parameters,
        std::vector<FDetection>& OutDetections
    );

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
    );

    void run_postprocess_fp_format_1(
        const rknn_context& ctx,
        const std::vector<rknn_output>& outputs,
        letterbox_t* letter_box,
        const input_parameters_t& input_parameters,
        std::vector<FDetection>& out_detections,
        ULogger* logger
    );

} // neural
} // varan