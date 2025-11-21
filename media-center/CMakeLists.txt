# CMakeList.txt: проект CMake для camera-threads-varan; включите исходный код и определения,
# укажите здесь логику для конкретного проекта.
#
cmake_minimum_required (VERSION 3.10)

# Включение горячей перезагрузки для компиляторов MSVC, если поддерживается.
if (POLICY CMP0141)
  cmake_policy(SET CMP0141 NEW)
  set(CMAKE_MSVC_DEBUG_INFORMATION_FORMAT "$<IF:$<AND:$<C_COMPILER_ID:MSVC>,$<CXX_COMPILER_ID:MSVC>>,$<$<CONFIG:Debug,RelWithDebInfo>:EditAndContinue>,$<$<CONFIG:Debug,RelWithDebInfo>:ProgramDatabase>>")
endif()

project ("camera-threads-varan")

file(
	GLOB_RECURSE SRC_FILES 
	${CMAKE_CURRENT_SOURCE_DIR}/src/*.cc 
	${CMAKE_CURRENT_SOURCE_DIR}/src/*.cpp
)

find_package(OpenCV REQUIRED)

# Поиск библиотек для работы с FFMPEG
find_package(PkgConfig REQUIRED)
pkg_check_modules(FFMPEG REQUIRED 
    libavcodec
    libavformat
    libavutil
    libswscale
    libavdevice
)
pkg_check_modules(GST_ALL REQUIRED gstreamer-1.0 gstreamer-allocators-1.0 gstreamer-base-1.0 gstreamer-webrtc-1.0 gstreamer-app-1.0 gstreamer-video-1.0 gstreamer-plugins-good-1.0 gstreamer-plugins-bad-1.0)

add_executable(${PROJECT_NAME} ${SRC_FILES})

if (CMAKE_VERSION VERSION_GREATER 3.12)
  set_property(TARGET camera-threads-varan PROPERTY CXX_STANDARD 20)
endif()

if (CMAKE_SYSTEM_NAME STREQUAL "Linux")
    set(THREADS_PREFER_PTHREAD_FLAG ON)
    find_package(Threads REQUIRED)
    target_link_libraries(${PROJECT_NAME} Threads::Threads)
endif()

target_link_libraries(${PROJECT_NAME}
	opencv_videoio
	opencv_imgcodecs
	opencv_imgproc
	opencv_core
    opencv_highgui
    ${FFMPEG_LIBRARIES}
    ${GST_ALL_LIBRARIES}
)

target_include_directories(${PROJECT_NAME} PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${GST_ALL_INCLUDE_DIRS}
)


# TODO: Добавьте тесты и целевые объекты, если это необходимо.
