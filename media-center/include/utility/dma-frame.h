#pragma once

#include <unistd.h>
#include <utility>
#include <cstddef>
#include <vector>
#include <string>
#include <functional>
#include <sstream>

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

using CDmabufMover = std::function<void(std::string, FDmabufFrame&&)>;