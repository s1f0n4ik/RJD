// Самопроверка разбора ошибок потока: текст rtspsrc -> числовой код: g++ -std=c++20 -Iinclude -I3rdparty/boost/include checks/stream-error-check.cpp -o /tmp/stream-error-check && /tmp/stream-error-check

#include <cstdio>
#include <cstdlib>

#include "nvr/stream-error.h"

using namespace varan::signaling;
using varan::nvr::classify_stream_error;

#define CHECK(cond) do { if (!(cond)) { std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); std::exit(1); } } while (0)

static void auth() {
    CHECK(classify_stream_error("Unauthorized") == CODE_RTSP_UNAUTHORIZED);
    CHECK(classify_stream_error("Could not get response: 401 Unauthorized") == CODE_RTSP_UNAUTHORIZED);
    CHECK(classify_stream_error("Forbidden") == CODE_RTSP_UNAUTHORIZED);
    std::puts("auth: OK");
}

static void unreachable() {
    CHECK(classify_stream_error("Could not connect to server. (Connection refused)") == CODE_RTSP_UNREACHABLE);
    CHECK(classify_stream_error("Failed to connect. (No route to host)") == CODE_RTSP_UNREACHABLE);
    CHECK(classify_stream_error("Network is unreachable") == CODE_RTSP_UNREACHABLE);
    // Имя хоста не найдено — это адрес, а не поток
    CHECK(classify_stream_error("Could not resolve host: cam.local (Name or service not known)") == CODE_RTSP_UNREACHABLE);
    CHECK(classify_stream_error("Host not found") == CODE_RTSP_UNREACHABLE);
    std::puts("unreachable: OK");
}

static void not_found() {
    CHECK(classify_stream_error("Not Found") == CODE_RTSP_NOT_FOUND);
    CHECK(classify_stream_error("RTSP/1.0 404") == CODE_RTSP_NOT_FOUND);
    std::puts("not_found: OK");
}

static void rest() {
    CHECK(classify_stream_error("Could not read from resource: timeout") == CODE_RTSP_TIMEOUT);
    CHECK(classify_stream_error("Connection timed out") == CODE_RTSP_TIMEOUT);
    CHECK(classify_stream_error("Could not receive message. (End of file)") == CODE_RTSP_DISCONNECTED);
    CHECK(classify_stream_error("Internal data stream error.") == CODE_GST_ERROR);
    CHECK(classify_stream_error("") == CODE_GST_ERROR);
    std::puts("rest: OK");
}

static void legacy() {
    // Старые сборки интерфейса не знают 3007 и читают её как общую ошибку GStreamer
    CHECK(std::string(legacy_stream_code(CODE_RTSP_UNREACHABLE)) == SIG_ERROR_GST_ERROR);
    std::puts("legacy: OK");
}

int main() {
    auth();
    unreachable();
    not_found();
    rest();
    legacy();
    std::puts("stream-error-check: OK");
    return 0;
}
