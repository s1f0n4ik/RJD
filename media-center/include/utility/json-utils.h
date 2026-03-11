#pragma once

#include <boost/json.hpp>

template<typename T>
static T get_json_value(const boost::json::value& val, const std::string& field) {
    const std::string dumped = boost::json::serialize(val);

    if constexpr (std::is_same_v<T, int64_t>) {
        if (!val.is_int64()) {
            throw std::runtime_error("JSON value error: <" + field + ": " + dumped + "> is not int64");
        }
        return val.as_int64();
    }
    else if constexpr (std::is_same_v<T, std::string>) {
        if (!val.is_string()) {
            throw std::runtime_error("JSON value " + field + ": " + dumped + " is not string");
        }
        return val.as_string().c_str();
    }
    else if constexpr (std::is_same_v<T, bool>) {
        if (!val.is_bool()) {
            throw std::runtime_error("JSON value " + field + ": " + dumped + " is not bool");
        }
        return val.as_bool();
    }
    else {
        static_assert(!sizeof(T*), "Unsupported type for get_json_value");
    }
}