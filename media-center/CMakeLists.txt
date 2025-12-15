# CMakeList.txt: проект CMake для camera-threads-varan; включите исходный код и определения,
# укажите здесь логику для конкретного проекта.
#
cmake_minimum_required (VERSION 3.10)

# Включение горячей перезагрузки для компиляторов MSVC, если поддерживается.
if (POLICY CMP0141)
  cmake_policy(SET CMP0141 NEW)
  set(CMAKE_MSVC_DEBUG_INFORMATION_FORMAT "$<IF:$<AND:$<C_COMPILER_ID:MSVC>,$<CXX_COMPILER_ID:MSVC>>,$<$<CONFIG:Debug,RelWithDebInfo>:EditAndContinue>,$<$<CONFIG:Debug,RelWithDebInfo>:ProgramDatabase>>")
endif()

project(media-center)

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
pkg_check_modules(GST_ALL REQUIRED 
    gstreamer-1.0 
    gstreamer-allocators-1.0 
    gstreamer-base-1.0 
    gstreamer-webrtc-1.0 
    gstreamer-app-1.0 
    gstreamer-video-1.0 
    gstreamer-plugins-good-1.0 
    gstreamer-plugins-bad-1.0 
    gstreamer-sdp-1.0
)

find_package(nlohmann_json REQUIRED)

find_package(OpenSSL REQUIRED)
find_package(ZLIB REQUIRED)

add_executable(${PROJECT_NAME} ${SRC_FILES})

if (CMAKE_VERSION VERSION_GREATER 3.12)
  set_property(TARGET media-center PROPERTY CXX_STANDARD 20)
endif()

if (CMAKE_SYSTEM_NAME STREQUAL "Linux")
    set(THREADS_PREFER_PTHREAD_FLAG ON)
    find_package(Threads REQUIRED)
    target_link_libraries(${PROJECT_NAME} Threads::Threads)
endif()


set(BOOST_ROOT ${CMAKE_SOURCE_DIR}/3rdparty/boost)
set(BOOST_INCLUDEDIR ${BOOST_ROOT}/include)
set(BOOST_LIBRARYDIR ${BOOST_ROOT}/lib)

# Тут явно перечисляем нужные библиотеки, например:
# Если в lib лежат, скажем, libboost_system.a и libboost_filesystem.a
link_directories(${Boost_LIBRARY_DIRS})

target_include_directories(${PROJECT_NAME} PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${GST_ALL_INCLUDE_DIRS}
    ${BOOST_INCLUDEDIR}
)

target_link_libraries(${PROJECT_NAME}
	opencv_videoio
	opencv_imgcodecs
	opencv_imgproc
	opencv_core
    opencv_highgui
    ${FFMPEG_LIBRARIES}
    ${GST_ALL_LIBRARIES}
    nlohmann_json::nlohmann_json
    Threads::Threads
    ${BOOST_LIBRARYDIR}/libboost_json.a
    ${BOOST_LIBRARYDIR}/libboost_filesystem.a
    ${BOOST_LIBRARYDIR}/libboost_thread.a
)

add_definitions(-DGST_USE_UNSTABLE_API)

# TODO: Добавьте тесты и целевые объекты, если это необходимо.
