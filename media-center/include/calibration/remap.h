#pragma once

#include <boost/json.hpp>
#include <opencv2/core.hpp>

#include <functional>
#include <map>
#include <memory>
#include <string>

namespace varan::calibration {

	class IRemapBuilder {
	public:
		virtual ~IRemapBuilder() = default;
		virtual void build(const boost::json::object& source, cv::Mat& x, cv::Mat& y) const = 0;
	};

	class URemapBuilder {
	public:
		URemapBuilder();
		std::string build(const boost::json::object& source, cv::Mat& x, cv::Mat& y) const;

	private:
		using CCreate = std::function<std::unique_ptr<IRemapBuilder>()>;
		std::map<std::string, CCreate> m_builders;
	};

}
