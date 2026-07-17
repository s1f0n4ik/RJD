# CMakeLists.txt для media-center с GStreamer 1.28

cmake_minimum_required(VERSION 3.18)
project(media-center VERSION 1.1.0 LANGUAGES C CXX)

# Стандарт C++
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

configure_file(
    ${CMAKE_SOURCE_DIR}/version.h.in
    ${CMAKE_BINARY_DIR}/generated/version.h
    @ONLY
)

# Исходники
file(GLOB_RECURSE SRC_FILES
    ${CMAKE_CURRENT_SOURCE_DIR}/src/*.cc
    ${CMAKE_CURRENT_SOURCE_DIR}/src/*.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/src/pipelines/*.cc
    ${CMAKE_CURRENT_SOURCE_DIR}/src/pipelines/*.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/src/main-server/*.cc
    ${CMAKE_CURRENT_SOURCE_DIR}/src/main-server/*.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/src/bird-view/*.cc
    ${CMAKE_CURRENT_SOURCE_DIR}/src/bird-view/*.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/src/calibration/*.cc
    ${CMAKE_CURRENT_SOURCE_DIR}/src/calibration/*.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/src/utility/*.cc
    ${CMAKE_CURRENT_SOURCE_DIR}/src/utility/*.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/src/core/*.cc
    ${CMAKE_CURRENT_SOURCE_DIR}/src/core/*.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/src/neural/*.cc
    ${CMAKE_CURRENT_SOURCE_DIR}/src/neural/*.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/src/gateway/*.cc
    ${CMAKE_CURRENT_SOURCE_DIR}/src/gateway/*.cpp
)

# OpenCV
find_package(OpenCV REQUIRED)

# Pkg-config
find_package(PkgConfig REQUIRED)

# Требуются пакеты: libprotobuf-dev protobuf-compiler libgrpc++-dev
#                   protobuf-compiler-grpc
find_package(Protobuf REQUIRED)
pkg_check_modules(GRPCPP REQUIRED IMPORTED_TARGET grpc++)
find_program(GRPC_CPP_PLUGIN grpc_cpp_plugin REQUIRED)

# Генерация protobuf + gRPC из proto/frame-ingress.proto в build-дерево.
# Вызываем protoc напрямую:
set(GATEWAY_PROTO_DIR ${CMAKE_CURRENT_BINARY_DIR}/generated-proto)
file(MAKE_DIRECTORY ${GATEWAY_PROTO_DIR})

set(GW_PROTO_FILE ${CMAKE_CURRENT_SOURCE_DIR}/proto/frame-ingress.proto)
set(GW_PROTO_SRCS
    ${GATEWAY_PROTO_DIR}/frame-ingress.pb.cc
    ${GATEWAY_PROTO_DIR}/frame-ingress.grpc.pb.cc)
set(GW_PROTO_HDRS
    ${GATEWAY_PROTO_DIR}/frame-ingress.pb.h
    ${GATEWAY_PROTO_DIR}/frame-ingress.grpc.pb.h)

add_custom_command(
    OUTPUT ${GW_PROTO_SRCS} ${GW_PROTO_HDRS}
    COMMAND ${Protobuf_PROTOC_EXECUTABLE}
        --proto_path=${CMAKE_CURRENT_SOURCE_DIR}/proto
        --cpp_out=${GATEWAY_PROTO_DIR}
        --grpc_out=${GATEWAY_PROTO_DIR}
        --plugin=protoc-gen-grpc=${GRPC_CPP_PLUGIN}
        ${GW_PROTO_FILE}
    DEPENDS ${GW_PROTO_FILE}
    COMMENT "Generating gRPC/protobuf from frame-ingress.proto"
    VERBATIM
)

add_library(mc-gateway-proto STATIC ${GW_PROTO_SRCS} ${GW_PROTO_HDRS})
target_include_directories(mc-gateway-proto PUBLIC ${GATEWAY_PROTO_DIR})
target_link_libraries(mc-gateway-proto PUBLIC protobuf::libprotobuf PkgConfig::GRPCPP)

# GStreamer 1.28 — явно через pkg-config
set(ENV{PKG_CONFIG_PATH} "/opt/gstreamer-1.28/lib/aarch64-linux-gnu/pkgconfig:$ENV{PKG_CONFIG_PATH}")

pkg_check_modules(GST_ALL REQUIRED
    gstreamer-1.0
    gstreamer-base-1.0
    gstreamer-app-1.0
    gstreamer-video-1.0
    gstreamer-allocators-1.0
    gstreamer-pbutils-1.0
    gstreamer-webrtc-1.0
    gstreamer-gl-1.0
    gstreamer-sdp-1.0
)

set(RKNN_INCLUDE_DIR ${CMAKE_SOURCE_DIR}/3rdparty/rknn/include)
set(RKNN_LIB_DIR ${CMAKE_SOURCE_DIR}/3rdparty/rknn/lib)

include_directories(
    ${RKNN_INCLUDE_DIR}
)

link_directories(
    ${GST_ALL_LIBRARY_DIRS}
    ${RKNN_LIB_DIR}
)

pkg_check_modules(EGL REQUIRED egl)
pkg_check_modules(GLESV2 REQUIRED glesv2)
pkg_check_modules(GBM REQUIRED gbm)

#include_directories(${GL_INCLUDE_DIRS})
#link_directories(${GL_LIBRARY_DIRS})

# Потоки
if (CMAKE_SYSTEM_NAME STREQUAL "Linux")
    set(THREADS_PREFER_PTHREAD_FLAG ON)
    find_package(Threads REQUIRED)
endif()

# glm
set(GLM ${CMAKE_SOURCE_DIR}/3rdparty/glm)

# Boost (локальная папка 3rdparty/boost)
set(BOOST_ROOT ${CMAKE_SOURCE_DIR}/3rdparty/boost)
set(BOOST_INCLUDEDIR ${BOOST_ROOT}/include)
set(BOOST_LIBRARYDIR ${BOOST_ROOT}/lib)

# Создание исполняемого файла
add_executable(${PROJECT_NAME} ${SRC_FILES})

# Директории для include
target_include_directories(${PROJECT_NAME} PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/generated
    ${GATEWAY_PROTO_DIR}
    ${GST_ALL_INCLUDE_DIRS}
    ${BOOST_INCLUDEDIR}
    ${GBM_INCLUDE_DIRS}
    ${GLM}
)

# Линковка библиотек
target_link_libraries(${PROJECT_NAME}
    ${GST_ALL_LIBRARIES}
    ${EGL_LIBRARIES}
    ${GLESV2_LIBRARIES}
    ${GST_GL_LIBRARIES}
    ${GBM_LIBRARIES}
    Threads::Threads
    opencv_core
    opencv_imgproc
    opencv_imgcodecs
    opencv_videoio
    opencv_highgui
    opencv_calib3d
    # Требует freetype (libfreetype-dev на устройстве)
    opencv_freetype
    ${BOOST_LIBRARYDIR}/libboost_json.a
    ${BOOST_LIBRARYDIR}/libboost_filesystem.a
    ${BOOST_LIBRARYDIR}/libboost_thread.a
    mc-gateway-proto
    rknnrt
)

# Копирование шейдеров в папку с билдом
file(COPY ${CMAKE_SOURCE_DIR}/shaders DESTINATION ${CMAKE_BINARY_DIR})

# Копирование шрифтов (кириллица для отрисовки на кадре, см. UTextRenderer)
# в папку с билдом — путь ищем от рабочей директории приложения, без опоры
# на системные шрифты устройства.
file(COPY ${CMAKE_SOURCE_DIR}/fonts DESTINATION ${CMAKE_BINARY_DIR})

# Неустойчивая API GStreamer
add_definitions(-DGST_USE_UNSTABLE_API)

# Проверка версии GStreamer во время компиляции
message(STATUS "Using GStreamer version: ${GST_ALL_VERSION}")

