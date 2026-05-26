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

static inline void pretty_print(std::ostream& os, const boost::json::value& value, std::string indent = "") {
	switch (value.kind()) {
	case boost::json::kind::object: {
		os << "{\n";

		auto const& obj = value.as_object();
		for (auto it = obj.begin(); it != obj.end(); ++it) {
			os << indent << "    " << boost::json::serialize(it->key()) << ": ";
			pretty_print(os, it->value(), indent + "    ");
			if (std::next(it) != obj.end()) {
				os << ",";
			}
			os << "\n";
		}
		os << indent << "}";
		break;
	}

	case boost::json::kind::array: {
		os << "[\n";
		auto const& arr = value.as_array();
		for (auto it = arr.begin(); it != arr.end(); ++it) {
			os << indent << "    ";
			pretty_print(os, *it, indent + "    ");
			if (std::next(it) != arr.end()) {
				os << ",";
			}
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