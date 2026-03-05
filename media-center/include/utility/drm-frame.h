#pragma once

#include <unistd.h>
#include <utility>
#include <cstddef>

struct FDmabufFrame
{
    int fd = -1;
    size_t size = 0;

    FDmabufFrame() = default;

    FDmabufFrame(int _fd, size_t _size)
        : fd(_fd), size(_size)
    {
    }

    FDmabufFrame(const FDmabufFrame&) = delete;
    FDmabufFrame& operator=(const FDmabufFrame&) = delete;

    FDmabufFrame(FDmabufFrame&& other) noexcept
        : fd(std::exchange(other.fd, -1)),
        size(std::exchange(other.size, 0))
    {
    }

    FDmabufFrame& operator=(FDmabufFrame&& other) noexcept {
        if (this != &other)
        {
            close_fd();
            fd = std::exchange(other.fd, -1);
            size = std::exchange(other.size, 0);
        }
        return *this;
    }

    ~FDmabufFrame() {
        close_fd();
    }

private:
    void close_fd() {
        if (fd >= 0) {
            ::close(fd);
            fd = -1;
        }
    }
};

using CDmabufMover = std::function<void(std::string, FDmabufFrame&&)>;