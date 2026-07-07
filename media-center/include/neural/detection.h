#pragma once

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