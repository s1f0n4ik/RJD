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

#include <iostream>
#include <stdio.h>
#include <stdlib.h>
#include <string>
#include <string.h>
#include <math.h>

#include "neural/yolov8.h"
#include "neural/common.h"
#include "neural/file-utils.h"
#include "neural/image-utils.h"

namespace varan {
namespace neural {
    static void dump_tensor_attr(rknn_tensor_attr* attr)
    {
        printf("  index=%d, name=%s, n_dims=%d, dims=[%d, %d, %d, %d], n_elems=%d, size=%d, fmt=%s, type=%s, qnt_type=%s, "
            "zp=%d, scale=%f\n",
            attr->index, attr->name, attr->n_dims, attr->dims[0], attr->dims[1], attr->dims[2], attr->dims[3],
            attr->n_elems, attr->size, get_format_string(attr->fmt), get_type_string(attr->type),
            get_qnt_type_string(attr->qnt_type), attr->zp, attr->scale);
    }

    int init_yolov8_model(const std::string& model_path, rknn_app_context_t* app_ctx)
    {
        int ret;
        rknn_context ctx = 0;

        // load_model возвращает std::vector<uint8_t>. Память освобождается автоматически.
        std::vector<uint8_t> model = load_model(model_path);
        if (model.empty()) {
            std::cerr << "init_yolov8_model(): load_model failed for " << model_path << std::endl;
            return -1;
        }

        ret = rknn_init(&ctx, model.data(), static_cast<uint32_t>(model.size()), 0, NULL);
        if (ret < 0) {
            std::cerr << "init_yolov8_model(): rknn_init fail! ret=" << ret << std::endl;
            return -1;
        }

        // Get Model Input Output Number
        rknn_input_output_num io_num;
        ret = rknn_query(ctx, RKNN_QUERY_IN_OUT_NUM, &io_num, sizeof(io_num));
        if (ret != RKNN_SUCC)
        {
            printf("rknn_query fail! ret=%d\n", ret);
            return -1;
        }
        printf("model input num: %d, output num: %d\n", io_num.n_input, io_num.n_output);

        // Get Model Input Info
        printf("input tensors:\n");
        rknn_tensor_attr input_attrs[io_num.n_input];
        memset(input_attrs, 0, sizeof(input_attrs));
        for (int i = 0; i < io_num.n_input; i++)
        {
            input_attrs[i].index = i;
            ret = rknn_query(ctx, RKNN_QUERY_INPUT_ATTR, &(input_attrs[i]), sizeof(rknn_tensor_attr));
            if (ret != RKNN_SUCC)
            {
                printf("rknn_query fail! ret=%d\n", ret);
                return -1;
            }
            dump_tensor_attr(&(input_attrs[i]));
        }

        // Get Model Output Info
        printf("output tensors:\n");
        rknn_tensor_attr output_attrs[io_num.n_output];
        memset(output_attrs, 0, sizeof(output_attrs));
        for (int i = 0; i < io_num.n_output; i++)
        {
            output_attrs[i].index = i;
            ret = rknn_query(ctx, RKNN_QUERY_OUTPUT_ATTR, &(output_attrs[i]), sizeof(rknn_tensor_attr));
            if (ret != RKNN_SUCC)
            {
                printf("rknn_query fail! ret=%d\n", ret);
                return -1;
            }
            dump_tensor_attr(&(output_attrs[i]));
        }

        // Set to context
        app_ctx->rknn_ctx = ctx;

        // TODO
        if (output_attrs[0].qnt_type == RKNN_TENSOR_QNT_AFFINE_ASYMMETRIC && output_attrs[0].type == RKNN_TENSOR_INT8)
        {
            app_ctx->is_quant = true;
        }
        else
        {
            app_ctx->is_quant = false;
        }

        app_ctx->io_num = io_num;
        app_ctx->input_attrs = (rknn_tensor_attr*)malloc(io_num.n_input * sizeof(rknn_tensor_attr));
        memcpy(app_ctx->input_attrs, input_attrs, io_num.n_input * sizeof(rknn_tensor_attr));
        app_ctx->output_attrs = (rknn_tensor_attr*)malloc(io_num.n_output * sizeof(rknn_tensor_attr));
        memcpy(app_ctx->output_attrs, output_attrs, io_num.n_output * sizeof(rknn_tensor_attr));

        if (input_attrs[0].fmt == RKNN_TENSOR_NCHW)
        {
            printf("model is NCHW input fmt\n");
            app_ctx->model_channel = input_attrs[0].dims[1];
            app_ctx->model_height = input_attrs[0].dims[2];
            app_ctx->model_width = input_attrs[0].dims[3];
        }
        else
        {
            printf("model is NHWC input fmt\n");
            app_ctx->model_height = input_attrs[0].dims[1];
            app_ctx->model_width = input_attrs[0].dims[2];
            app_ctx->model_channel = input_attrs[0].dims[3];
        }
        printf("model input height=%d, width=%d, channel=%d\n",
            app_ctx->model_height, app_ctx->model_width, app_ctx->model_channel);

        return 0;
    }

    int release_yolov8_model(rknn_app_context_t* app_ctx)
    {
        if (app_ctx->input_attrs != NULL)
        {
            free(app_ctx->input_attrs);
            app_ctx->input_attrs = NULL;
        }
        if (app_ctx->output_attrs != NULL)
        {
            free(app_ctx->output_attrs);
            app_ctx->output_attrs = NULL;
        }
        if (app_ctx->rknn_ctx != 0)
        {
            rknn_destroy(app_ctx->rknn_ctx);
            app_ctx->rknn_ctx = 0;
        }
        return 0;
    }

    int inference_yolo_rknn(
        rknn_app_context_t* app_ctx,
        const cv::Mat& src_bgr,
        const std::vector<FClassInfo>& classes,
        float threshold_nms,
        float conf_threshold,
        yolo_inference_result_t& result,
        ULogger* logger)
    {
        if (!app_ctx) return -1;
        if (src_bgr.empty()) return -1;

        const int model_w = app_ctx->model_width;
        const int model_h = app_ctx->model_height;

        // ── 1) Letterbox-ресайз (BGR на этом шаге) ──
        cv::Mat input_bgr = resize_with_aspect_ratio(src_bgr, model_w, model_h,
            cv::Scalar(114, 114, 114));
        if (input_bgr.empty()) {
            if (logger) logger->error("inference_yolo_rknn(): resize failed");
            return -1;
        }

        // ── 2) Конвертация BGR → RGB (модель Ultralytics ждёт RGB) ──
        cv::Mat input_rgb;
        cv::cvtColor(input_bgr, input_rgb, cv::COLOR_BGR2RGB);

        // ── 3) Параметры letterbox для постпроцесса ──
        const letterbox_t letter_box = compute_letterbox_params(src_bgr.cols, src_bgr.rows,
            model_w, model_h);

        image_buffer_t src_meta{ src_bgr.cols, src_bgr.rows };

        // ── 4) Подача в RKNN ──
        std::vector<rknn_input>  inputs(app_ctx->io_num.n_input);
        std::vector<rknn_output> outputs(app_ctx->io_num.n_output);

        // Гарантируем continuous buffer.
        if (!input_rgb.isContinuous()) input_rgb = input_rgb.clone();

        inputs[0].index = 0;
        inputs[0].type = RKNN_TENSOR_UINT8;
        inputs[0].fmt = RKNN_TENSOR_NHWC;
        inputs[0].size = static_cast<uint32_t>(model_w * model_h * 3);
        inputs[0].buf = input_rgb.data;

        int ret = rknn_inputs_set(app_ctx->rknn_ctx, app_ctx->io_num.n_input, inputs.data());
        if (ret < 0) {
            if (logger) logger->error("rknn_input_set fail! ret=" + std::to_string(ret));
            return -1;
        }

        ret = rknn_run(app_ctx->rknn_ctx, nullptr);
        if (ret < 0) {
            if (logger) logger->error("rknn_run fail! ret=" + std::to_string(ret));
            return -1;
        }

        for (int i = 0; i < (int)app_ctx->io_num.n_output; ++i) {
            outputs[i].index = i;
            outputs[i].want_float = (!app_ctx->is_quant);
        }

        ret = rknn_outputs_get(app_ctx->rknn_ctx, app_ctx->io_num.n_output, outputs.data(), nullptr);
        if (ret < 0) {
            if (logger) logger->error("rknn_outputs_get fail! ret=" + std::to_string(ret));
            return ret;
        }

        // ── 6) Постпроцесс ──
        auto* lb = const_cast<letterbox_t*>(&letter_box);  // постпроцесс ждёт указатель
        if (app_ctx->is_quant && app_ctx->io_num.n_output == 4) {
            run_postprocess_int8_segmentation(
                app_ctx->rknn_ctx, outputs, lb, &src_meta,
                { src_meta.width, src_meta.height,
                  model_w, model_h, 64, 32,
                  threshold_nms, conf_threshold, classes },
                result.detections, result.mask);
        }
        else if (app_ctx->is_quant && app_ctx->io_num.n_output == 3) {
            run_postprocess_int8_format_3(
                app_ctx->rknn_ctx, outputs, lb, &src_meta,
                { src_meta.width, src_meta.height,
                  model_w, model_h, 64, 0,
                  threshold_nms, conf_threshold, classes },
                result.detections);
        }
        else if (!app_ctx->is_quant && app_ctx->io_num.n_output == 3) {
            run_postprocess_float32_format_3(
                *app_ctx, outputs, lb, &src_meta,
                model_w, model_h, classes.size(),
                threshold_nms, conf_threshold,
                result.detections);
        }
        else if (!app_ctx->is_quant && app_ctx->io_num.n_output == 1) {
            run_postprocess_fp_format_1(
                app_ctx->rknn_ctx, outputs, lb,
                { src_meta.width, src_meta.height,
                  model_w, model_h, 64, 0,
                  threshold_nms, conf_threshold, classes },
                result.detections, logger);
        }
        else {
            if (logger) logger->error("inference_yolo_rknn(): no matching postprocess branch");
        }

        rknn_outputs_release(app_ctx->rknn_ctx, app_ctx->io_num.n_output, outputs.data());
        return ret;
    }
} // neural
} // varan