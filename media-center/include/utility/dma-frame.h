#pragma once

#include <unistd.h>
#include <utility>
#include <cstddef>
#include <vector>
#include <string>
#include <functional>
#include <sstream>

#include <sys/mman.h>
#include <opencv2/opencv.hpp>
#include <iostream>

struct FDmabufPlane {
    uint32_t stride = 0;
    uint32_t offset = 0;
    uint32_t height = 0;
};

struct FDmabufFrame
{
    std::vector<int> fds;

    uint32_t width;
    uint32_t height;
    uint64_t pts;

    size_t size = 0;

    std::string format;

    std::vector<FDmabufPlane> planes;

    FDmabufFrame() = default;

    ~FDmabufFrame()
    {
        close_fds();
    }

    FDmabufFrame(const FDmabufFrame&) = delete;
    FDmabufFrame& operator=(const FDmabufFrame&) = delete;

    FDmabufFrame(FDmabufFrame&& other) noexcept
        : fds(std::move(other.fds))
        , width(other.width)
        , height(other.height)
        , size(other.size)
        , format(std::move(other.format))
        , planes(std::move(other.planes))
    {
        other.width = 0;
        other.height = 0;
        other.size = 0;
    }

    FDmabufFrame& operator=(FDmabufFrame&& other) noexcept 
    {
        if (this != &other) {
            close_fds();

            fds = std::move(other.fds);
            width = other.width;
            height = other.height;
            size = other.size;
            format = std::move(other.format);
            planes = std::move(other.planes);

            other.width = 0;
            other.height = 0;
            other.size = 0;
        }
        return *this;
    }

    std::string to_string() const
    {
        std::ostringstream ss;

        ss << "DMABUF Frame:\n";
        ss << "  Width: " << width << "\n";
        ss << "  Height: " << height << "\n";
        ss << "  Format: " << format << "\n";
        ss << "  Total size: " << size << " bytes\n";
        ss << "  PTS: " << pts << "\n";

        ss << "  FDs (" << fds.size() << "): ";
        for (size_t i = 0; i < fds.size(); ++i) {
            ss << fds[i];
            if (i + 1 < fds.size()) {
                ss << ", ";
            }
        }
        ss << "\n";

        ss << "  Planes (" << planes.size() << "):\n";

        for (size_t i = 0; i < planes.size(); ++i) {
            const auto& p = planes[i];
            ss << "    Plane " << i << ":\n";
            ss << "      Stride: " << p.stride << "\n";
            ss << "      Offset: " << p.offset << "\n";
            ss << "      Height: " << p.height << "\n";
        }

        return ss.str();
    }

private:
    void close_fds()
    {
        for (int fd : fds) {
            if (fd >= 0) {
                close(fd);
            }
        }
        fds.clear();
    }
};

inline bool save_nv12_dmabuf_to_jpeg_opencv(const FDmabufFrame& frame,
                                     const std::string& filename,
                                     int quality = 95)
{
    if (frame.fds.size() != 1 || frame.planes.empty()) {
        std::cerr << "Invalid frame\n";
        return false;
    }

    int fd = frame.fds[0];
    const auto& p = frame.planes[0];

    size_t map_size = frame.size;
    if (map_size == 0) {
        map_size = p.stride * frame.height * 3 / 2;
    }

    uint8_t* base = (uint8_t*)mmap(nullptr, map_size, PROT_READ, MAP_SHARED, fd, 0);
    if (base == MAP_FAILED) {
        perror("mmap");
        return false;
    }

    uint8_t* y_plane  = base + p.offset;
    uint8_t* uv_plane = y_plane + p.stride * frame.height;

    cv::Mat y(frame.height, p.stride, CV_8UC1, y_plane);

    bool ok = cv::imwrite(filename, y);

    // ---- Собираем NV12 как один Mat ----
    cv::Mat nv12(frame.height + frame.height / 2,
                 p.stride,
                 CV_8UC1,
                 y_plane);

    // ---- Конвертация в BGR ----
    cv::Mat bgr;
    cv::cvtColor(nv12, bgr, cv::COLOR_YUV2BGR_NV12);

    // ---- Обрезаем по реальной ширине (stride может быть больше) ----
    cv::Mat cropped = bgr(cv::Rect(0, 0, frame.width, frame.height));

    // ---- Сохраняем JPEG ----
    std::vector<int> params = {
        cv::IMWRITE_JPEG_QUALITY, quality
    };

    //bool ok = cv::imwrite(filename, cropped, params);

    munmap(base, map_size);

    if (!ok) {
        std::cerr << "Failed to write JPEG\n";
        return false;
    }

    std::cout << "Saved JPEG: " << filename << "\n";
    return true;
}

using CDmabufMover = std::function<void(std::string, FDmabufFrame&&)>;