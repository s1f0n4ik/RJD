// Copyright (c) 2023 by Rockchip Electronics Co., Ltd. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.


#ifndef _RKNN_DEMO_YOLOV8_H_
#define _RKNN_DEMO_YOLOV8_H_
#include "neural/postprocess.h"
#include "neural/utility.h"

namespace varan {
namespace neural {

    typedef struct FYolo_Result {
        std::vector<FDetection> detections;
        std::vector<uint8_t> mask;
    } yolo_inference_result_t;

    int init_yolov8_model(const std::string& model_path, rknn_app_context_t* app_ctx);

    int release_yolov8_model(rknn_app_context_t* app_ctx);

    int inference_yolo_rknn(
        rknn_app_context_t* app_ctx,
        const cv::Mat& src_bgr,
        const std::vector<FClassInfo>& classes,
        float threshold_nms,
        float conf_threshold,
        yolo_inference_result_t& result,
        ULogger* logger
    );

}
}

#endif //_RKNN_DEMO_YOLOV8_H_