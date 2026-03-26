# CMakeLists.txt для media-center с GStreamer 1.28

cmake_minimum_required(VERSION 3.18)
project(media-center VERSION 1.0 LANGUAGES C CXX)

# Стандарт C++
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

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
)

# OpenCV
find_package(OpenCV REQUIRED)

# Pkg-config
find_package(PkgConfig REQUIRED)

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
    #gstreamer-plugins-bad-1.0
    gstreamer-sdp-1.0
)

link_directories(${GST_ALL_LIBRARY_DIRS})

pkg_check_modules(GL REQUIRED glesv2 egl)

include_directories(${GL_INCLUDE_DIRS})
link_directories(${GL_LIBRARY_DIRS})

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
    ${GST_ALL_INCLUDE_DIRS}
    ${BOOST_INCLUDEDIR}
    ${GLM}
)

# Линковка библиотек
target_link_libraries(${PROJECT_NAME}
    ${GST_ALL_LIBRARIES}
    ${GL_LIBRARIES}
    Threads::Threads
    opencv_core
    opencv_imgproc
    opencv_imgcodecs
    opencv_videoio
    opencv_highgui
    ${BOOST_LIBRARYDIR}/libboost_json.a
    ${BOOST_LIBRARYDIR}/libboost_filesystem.a
    ${BOOST_LIBRARYDIR}/libboost_thread.a
)

# Копирование шейдеров в папку с билдом
file(COPY ${CMAKE_SOURCE_DIR}/shaders DESTINATION ${CMAKE_BINARY_DIR})

# Неустойчивая API GStreamer
add_definitions(-DGST_USE_UNSTABLE_API)

# Проверка версии GStreamer во время компиляции
message(STATUS "Using GStreamer version: ${GST_ALL_VERSION}")

