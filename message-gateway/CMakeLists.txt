cmake_minimum_required(VERSION 3.16)
project(message-gateway CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Boost ставится в контейнере (libboost-dev + libboost-json-dev). beast/asio —
# header-only, из json нужна скомпилированная часть.
find_package(Threads REQUIRED)
find_package(Boost REQUIRED COMPONENTS json)
find_package(Protobuf CONFIG REQUIRED)
find_package(gRPC CONFIG REQUIRED)

# Генерация protobuf + gRPC из proto/frame-ingress.proto в build-дерево.
set(GENERATED_DIR ${CMAKE_CURRENT_BINARY_DIR}/generated)
file(MAKE_DIRECTORY ${GENERATED_DIR})

add_library(gateway-proto OBJECT proto/frame-ingress.proto)
target_link_libraries(gateway-proto PUBLIC protobuf::libprotobuf gRPC::grpc++)
target_include_directories(gateway-proto PUBLIC ${GENERATED_DIR})

protobuf_generate(
    TARGET gateway-proto
    LANGUAGE cpp
    PROTOC_OUT_DIR ${GENERATED_DIR}
)
protobuf_generate(
    TARGET gateway-proto
    LANGUAGE grpc
    GENERATE_EXTENSIONS .grpc.pb.h .grpc.pb.cc
    PLUGIN "protoc-gen-grpc=$<TARGET_FILE:gRPC::grpc_cpp_plugin>"
    PROTOC_OUT_DIR ${GENERATED_DIR}
)

add_executable(${PROJECT_NAME}
    src/main.cpp
    src/gateway.cpp
    src/frame-codec-v1.cpp
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
    gRPC::grpc++
    Threads::Threads
)

if(WIN32)
    target_link_libraries(${PROJECT_NAME} PRIVATE ws2_32 wsock32)
endif()
