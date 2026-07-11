cmake_minimum_required(VERSION 3.16)
project(message-gateway CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Boost ставится в контейнере (libboost-dev + libboost-json-dev). beast/asio —
# header-only, из json нужна скомпилированная часть.
find_package(Threads REQUIRED)
find_package(Boost REQUIRED COMPONENTS json)

# Пакеты Ubuntu (libprotobuf-dev / libgrpc++-dev) не кладут CMake-конфиги,
# поэтому protobuf ищем module-режимом (FindProtobuf), а gRPC — через pkg-config.
find_package(Protobuf REQUIRED)
find_package(PkgConfig REQUIRED)
pkg_check_modules(GRPCPP REQUIRED IMPORTED_TARGET grpc++)

# Плагин генерации gRPC-кода идёт бинарником из protobuf-compiler-grpc.
find_program(GRPC_CPP_PLUGIN grpc_cpp_plugin REQUIRED)

# Генерация protobuf + gRPC из proto/frame-ingress.proto в build-дерево.
set(GENERATED_DIR ${CMAKE_CURRENT_BINARY_DIR}/generated)
file(MAKE_DIRECTORY ${GENERATED_DIR})

add_library(gateway-proto OBJECT proto/frame-ingress.proto)
target_link_libraries(gateway-proto PUBLIC protobuf::libprotobuf PkgConfig::GRPCPP)
target_include_directories(gateway-proto PUBLIC ${GENERATED_DIR})

# IMPORT_DIRS = каталог proto/, чтобы protoc считал путь относительно него и
# клал .pb.h/.grpc.pb.h плоско в GENERATED_DIR (без подкаталога proto/).
protobuf_generate(
    TARGET gateway-proto
    LANGUAGE cpp
    IMPORT_DIRS ${CMAKE_CURRENT_SOURCE_DIR}/proto
    PROTOC_OUT_DIR ${GENERATED_DIR}
)
protobuf_generate(
    TARGET gateway-proto
    LANGUAGE grpc
    GENERATE_EXTENSIONS .grpc.pb.h .grpc.pb.cc
    PLUGIN "protoc-gen-grpc=${GRPC_CPP_PLUGIN}"
    IMPORT_DIRS ${CMAKE_CURRENT_SOURCE_DIR}/proto
    PROTOC_OUT_DIR ${GENERATED_DIR}
)

add_executable(${PROJECT_NAME}
    src/main.cpp
    src/gateway.cpp
    src/frame-codec-v1.cpp
    src/rsm2000-integration.cpp
    src/grpc-ingress.cpp
    $<TARGET_OBJECTS:gateway-proto>
)

target_include_directories(${PROJECT_NAME} PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${GENERATED_DIR}
)

target_link_libraries(${PROJECT_NAME} PRIVATE
    Boost::json
    Boost::headers
    protobuf::libprotobuf
    PkgConfig::GRPCPP
    Threads::Threads
)

if(WIN32)
    target_link_libraries(${PROJECT_NAME} PRIVATE ws2_32 wsock32)
endif()
