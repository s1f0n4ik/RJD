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

static inline bool is_compact_array(const boost::json::array& arr) {
    if (arr.size() > 4) return false;
    for (const auto& v : arr) {
        if (!v.is_int64() && !v.is_uint64() && !v.is_double()) return false;
    }
    return true;
}

static inline void pretty_print(std::ostream& os, const boost::json::value& value, std::string indent = "") {
    switch (value.kind()) {
    case boost::json::kind::object: {
        os << "{\n";
        auto const& obj = value.as_object();
        for (auto it = obj.begin(); it != obj.end(); ++it) {
            os << indent << "    " << boost::json::serialize(it->key()) << ": ";
            pretty_print(os, it->value(), indent + "    ");
            if (std::next(it) != obj.end()) os << ",";
            os << "\n";
        }
        os << indent << "}";
        break;
    }

    case boost::json::kind::array: {
        auto const& arr = value.as_array();

        // Компактный массив чисел — в одну строку
        if (is_compact_array(arr)) {
            os << "[";
            for (auto it = arr.begin(); it != arr.end(); ++it) {
                if (it != arr.begin()) os << ", ";
                if (it->is_int64())       os << it->as_int64();
                else if (it->is_uint64()) os << it->as_uint64();
                else if (it->is_double()) os << it->as_double();
            }
            os << "]";
            break;
        }

        // Массив компактных массивов — каждая пара на своей строке
        bool all_compact = !arr.empty();
        for (const auto& v : arr) {
            if (!v.is_array() || !is_compact_array(v.as_array())) {
                all_compact = false;
                break;
            }
        }

        if (all_compact) {
            os << "[\n";
            for (auto it = arr.begin(); it != arr.end(); ++it) {
                os << indent << "    ";
                pretty_print(os, *it, indent + "    ");
                if (std::next(it) != arr.end()) os << ",";
                os << "\n";
            }
            os << indent << "]";
            break;
        }

        // Обычный массив
        os << "[\n";
        for (auto it = arr.begin(); it != arr.end(); ++it) {
            os << indent << "    ";
            pretty_print(os, *it, indent + "    ");
            if (std::next(it) != arr.end()) os << ",";
            os << "\n";
        }
        os << indent << "]";
        break;
    }

    case boost::json::kind::string:
        os << boost::json::serialize(value.as_string());
        break;

    case boost::json::kind::uint64:
        os << value.as_uint64();
        break;

    case boost::json::kind::int64:
        os << value.as_int64();
        break;

    case boost::json::kind::double_: {
        std::streamsize old_precision = os.precision();
        os << std::setprecision(17) << value.as_double();
        os.precision(old_precision);
        break;
    }

    case boost::json::kind::bool_:
        os << (value.as_bool() ? "true" : "false");
        break;

    case boost::json::kind::null:
        os << "null";
        break;
    }
}