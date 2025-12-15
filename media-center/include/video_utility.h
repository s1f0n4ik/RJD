#pragma once
#include <gst/video/video.h>
#include <drm/drm_fourcc.h>

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