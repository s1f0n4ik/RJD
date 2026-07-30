#pragma once
#include <gst/video/video.h>
#include <drm/drm_fourcc.h>

#include <chrono>
#include <ctime>
#include <iomanip>
#include <sstream>

#include "core/time-sync.h"

inline GstVideoFormat drm_to_gst_video_format(uint32_t fourcc)
{
    switch (fourcc)
    {
    case DRM_FORMAT_NV12:
        return GST_VIDEO_FORMAT_NV12;

    case DRM_FORMAT_NV21:
        return GST_VIDEO_FORMAT_NV21;

    case DRM_FORMAT_YUV420:
        return GST_VIDEO_FORMAT_I420;

    case DRM_FORMAT_YVU420:
        return GST_VIDEO_FORMAT_YV12;

    case DRM_FORMAT_YUYV:
        return GST_VIDEO_FORMAT_YUY2;

    case DRM_FORMAT_UYVY:
        return GST_VIDEO_FORMAT_UYVY;

    case DRM_FORMAT_VYUY:
        return GST_VIDEO_FORMAT_VYUY;

    case DRM_FORMAT_YVYU:
        return GST_VIDEO_FORMAT_YVYU;

    case DRM_FORMAT_RGB888:
        return GST_VIDEO_FORMAT_RGB;

    case DRM_FORMAT_BGR888:
        return GST_VIDEO_FORMAT_BGR;

    case DRM_FORMAT_ARGB8888:
        return GST_VIDEO_FORMAT_ARGB;

    case DRM_FORMAT_BGRA8888:
        return GST_VIDEO_FORMAT_BGRA;

    case DRM_FORMAT_XRGB8888:
        return GST_VIDEO_FORMAT_xRGB;

    case DRM_FORMAT_XBGR8888:
        return GST_VIDEO_FORMAT_xBGR;

    case DRM_FORMAT_RGBA8888:
        return GST_VIDEO_FORMAT_RGBA;

    case DRM_FORMAT_ABGR8888:
        return GST_VIDEO_FORMAT_ABGR;

    case DRM_FORMAT_NV16:
        return GST_VIDEO_FORMAT_NV16;

    case DRM_FORMAT_NV61:
        return GST_VIDEO_FORMAT_NV61;

    case DRM_FORMAT_NV24:
        return GST_VIDEO_FORMAT_NV24;

    case DRM_FORMAT_P010:
        return GST_VIDEO_FORMAT_P010_10LE;

    case DRM_FORMAT_P016:
        return GST_VIDEO_FORMAT_P016_LE;

    case DRM_FORMAT_R8:
        return GST_VIDEO_FORMAT_GRAY8;

    case DRM_FORMAT_R16:
        return GST_VIDEO_FORMAT_GRAY16_LE;

    default:
        return GST_VIDEO_FORMAT_UNKNOWN;
    }
}

// Вовзращаем формат %Y-%m-%d_%H-%M-%S
static std::string make_start_timestamp() {
    std::tm tm{};

    // Время шлюза приходит уже сдвинутым на настроенный пояс — форматируем
    // gmtime, чтобы пояс контейнера не наложился вторым слоем. Без
    // синхронизации остаются системные часы в локальном поясе, как раньше
    if (varan::time_sync::synced()) {
        const std::time_t t = static_cast<std::time_t>(varan::time_sync::now_ms() / 1000);
        gmtime_r(&t, &tm);
    }
    else {
        auto now = std::chrono::system_clock::now();
        std::time_t t = std::chrono::system_clock::to_time_t(now);
        localtime_r(&t, &tm);
    }

    std::ostringstream oss;
    oss << std::put_time(&tm, "%Y-%m-%d_%H-%M-%S");
    return oss.str();
}