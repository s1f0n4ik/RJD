#pragma once

#include <vector>
#include <opencv2/core/types.hpp>

struct FDetection
{
    int x1_coord;
    int y1_coord;
    int x2_coord;
    int y2_coord;
    float confidence;

    int class_id;

    // Коэффициенты маски seg-модели; живут от разбора до сборки контуров
    std::vector<float> mask_coefficients;
    // Внешние контуры маски в тех же координатах, что и рамка; пусто у моделей без масок
    std::vector<std::vector<cv::Point>> polygons;
    // Зона каталога на этом кадре; 0 — вне зон
    int zone = 0;
};
