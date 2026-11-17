#include "utility/v4l2-devices.h"

#include <cctype>
#include <cerrno>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <utility>

#include <fcntl.h>
#include <sys/ioctl.h>
#include <unistd.h>

#include <linux/media-bus-format.h>
#include <linux/v4l2-subdev.h>
#include <linux/videodev2.h>

namespace fs = std::filesystem;

namespace varan {
namespace nvr {

	namespace {

		// Узел ISP, который отдаёт кадр приложению
		constexpr const char* kCsiNode = "rkisp_mainpath";
		// Сенсор в дереве rkisp называется m00_b_<модель>
		constexpr const char* kSensorPrefix = "m0";
		constexpr const char* kIspSubdev = "rkisp-isp-subdev";

		// Форматы, которые умеет вход MC
		const std::pair<uint32_t, const char*> kFormats[] = {
			{ V4L2_PIX_FMT_YUYV, "YUYV" },
			{ V4L2_PIX_FMT_UYVY, "UYVY" },
			{ V4L2_PIX_FMT_NV12, "NV12" },
			{ V4L2_PIX_FMT_MJPEG, "MJPG" },
		};

		struct FFd {
			int fd = -1;
			FFd(const std::string& path, int flags) { if (!path.empty()) fd = ::open(path.c_str(), flags); }
			~FFd() { if (fd >= 0) ::close(fd); }
			FFd(const FFd&) = delete;
			FFd& operator=(const FFd&) = delete;
			bool ok() const { return fd >= 0; }
		};

		int xioctl(int fd, unsigned long request, void* arg) {
			int result = 0;
			do { result = ::ioctl(fd, request, arg); } while (result == -1 && errno == EINTR);
			return result;
		}

		std::string read_line(const fs::path& path) {
			std::ifstream file(path);
			std::string line;
			std::getline(file, line);
			while (!line.empty() && (line.back() == '\r' || line.back() == ' ')) line.pop_back();
			return line;
		}

		// Узлы /dev/<kind>N из /sys/class/video4linux по имени; prefix — имя начинается с name
		std::vector<std::string> nodes_named(const std::string& name, bool prefix, const std::string& kind) {
			std::vector<std::string> result;
			std::error_code ec;
			for (const auto& entry : fs::directory_iterator("/sys/class/video4linux", ec)) {
				const std::string node = entry.path().filename().string();
				if (node.rfind(kind, 0) != 0) continue;

				const std::string got = read_line(entry.path() / "name");
				if (prefix ? got.rfind(name, 0) == 0 : got == name) result.push_back("/dev/" + node);
			}
			std::sort(result.begin(), result.end());
			return result;
		}

		// Модель сенсора по имени subdev m00_b_imx219 2-0010: IMX219; пусто — сенсора нет
		std::string sensor_model() {
			std::error_code ec;
			for (const auto& entry : fs::directory_iterator("/sys/class/video4linux", ec)) {
				if (entry.path().filename().string().rfind("v4l-subdev", 0) != 0) continue;
				const std::string name = read_line(entry.path() / "name");
				if (name.rfind(kSensorPrefix, 0) != 0) continue;

				const auto start = name.find('_', name.find('_') + 1);
				if (start == std::string::npos) return {};
				std::string model = name.substr(start + 1, name.find(' ', start) - start - 1);
				std::transform(model.begin(), model.end(), model.begin(),
					[](unsigned char c) { return static_cast<char>(std::toupper(c)); });
				return model;
			}
			return {};
		}

		// Целые частоты, которые драйвер называет для формата и размера, от большей к меньшей
		std::vector<int> frame_rates(int fd, uint32_t pixel_format, uint32_t width, uint32_t height) {
			std::vector<int> rates;
			v4l2_frmivalenum interval{};
			interval.pixel_format = pixel_format;
			interval.width = width;
			interval.height = height;

			for (interval.index = 0; interval.index < 64 && xioctl(fd, VIDIOC_ENUM_FRAMEINTERVALS, &interval) == 0; ++interval.index) {
				if (interval.type != V4L2_FRMIVAL_TYPE_DISCRETE) break;
				const auto& period = interval.discrete;
				if (period.numerator > 0 && period.denominator % period.numerator == 0) {
					rates.push_back(static_cast<int>(period.denominator / period.numerator));
				}
			}

			std::sort(rates.rbegin(), rates.rend());
			rates.erase(std::unique(rates.begin(), rates.end()), rates.end());
			return rates;
		}

		std::vector<FV4l2Format> formats_of(int fd, uint32_t buffer_type) {
			std::vector<FV4l2Format> result;
			v4l2_fmtdesc desc{};
			desc.type = buffer_type;

			for (desc.index = 0; desc.index < 64 && xioctl(fd, VIDIOC_ENUM_FMT, &desc) == 0; ++desc.index) {
				const auto known = std::find_if(std::begin(kFormats), std::end(kFormats),
					[&](const auto& item) { return item.first == desc.pixelformat; });
				if (known == std::end(kFormats)) continue;

				FV4l2Format format;
				format.format = known->second;

				v4l2_frmsizeenum size{};
				size.pixel_format = desc.pixelformat;
				for (size.index = 0; size.index < 64 && xioctl(fd, VIDIOC_ENUM_FRAMESIZES, &size) == 0; ++size.index) {
					if (size.type == V4L2_FRMSIZE_TYPE_DISCRETE) {
						const auto& frame = size.discrete;
						format.sizes.push_back({ static_cast<int>(frame.width), static_cast<int>(frame.height),
							frame_rates(fd, desc.pixelformat, frame.width, frame.height) });
						continue;
					}

					const auto& range = size.stepwise;
					format.stepwise = true;
					format.min_width = static_cast<int>(range.min_width);
					format.max_width = static_cast<int>(range.max_width);
					format.step_width = static_cast<int>(range.step_width);
					format.min_height = static_cast<int>(range.min_height);
					format.max_height = static_cast<int>(range.max_height);
					format.step_height = static_cast<int>(range.step_height);
					break;
				}

				if (format.stepwise || !format.sizes.empty()) result.push_back(std::move(format));
			}

			return result;
		}

		// Узел захвата с форматами MC; пусто — это не камера, метаданные UVC или чужой драйвер
		std::optional<FV4l2Camera> describe(const std::string& node, const std::string& device, bool csi) {
			FFd file(node, O_RDONLY | O_NONBLOCK);
			if (!file.ok()) return std::nullopt;

			v4l2_capability cap{};
			if (xioctl(file.fd, VIDIOC_QUERYCAP, &cap) != 0) return std::nullopt;

			if (!csi && std::string(reinterpret_cast<const char*>(cap.driver)) != "uvcvideo") return std::nullopt;

			// USB-камеры отвечают на обычный CAPTURE, rkisp только на MPLANE
			const uint32_t caps = (cap.capabilities & V4L2_CAP_DEVICE_CAPS) ? cap.device_caps : cap.capabilities;
			const uint32_t type = (caps & V4L2_CAP_VIDEO_CAPTURE) ? V4L2_BUF_TYPE_VIDEO_CAPTURE
				: (caps & V4L2_CAP_VIDEO_CAPTURE_MPLANE) ? V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE : 0;
			if (type == 0) return std::nullopt;

			FV4l2Camera camera;
			camera.device = device;
			camera.node = node;
			camera.name = reinterpret_cast<const char*>(cap.card);
			camera.csi = csi;
			camera.formats = formats_of(file.fd, type);
			if (camera.formats.empty()) return std::nullopt;
			return camera;
		}

		// Отражение по обеим осям сдвигает мозаику на пиксель по диагонали: RGGB <-> BGGR, GRBG <-> GBRG
		unsigned mirrored_bayer_code(unsigned code) {
			switch (code) {
			case MEDIA_BUS_FMT_SRGGB8_1X8:   return MEDIA_BUS_FMT_SBGGR8_1X8;
			case MEDIA_BUS_FMT_SBGGR8_1X8:   return MEDIA_BUS_FMT_SRGGB8_1X8;
			case MEDIA_BUS_FMT_SGRBG8_1X8:   return MEDIA_BUS_FMT_SGBRG8_1X8;
			case MEDIA_BUS_FMT_SGBRG8_1X8:   return MEDIA_BUS_FMT_SGRBG8_1X8;
			case MEDIA_BUS_FMT_SRGGB10_1X10: return MEDIA_BUS_FMT_SBGGR10_1X10;
			case MEDIA_BUS_FMT_SBGGR10_1X10: return MEDIA_BUS_FMT_SRGGB10_1X10;
			case MEDIA_BUS_FMT_SGRBG10_1X10: return MEDIA_BUS_FMT_SGBRG10_1X10;
			case MEDIA_BUS_FMT_SGBRG10_1X10: return MEDIA_BUS_FMT_SGRBG10_1X10;
			case MEDIA_BUS_FMT_SRGGB12_1X12: return MEDIA_BUS_FMT_SBGGR12_1X12;
			case MEDIA_BUS_FMT_SBGGR12_1X12: return MEDIA_BUS_FMT_SRGGB12_1X12;
			case MEDIA_BUS_FMT_SGRBG12_1X12: return MEDIA_BUS_FMT_SGBRG12_1X12;
			case MEDIA_BUS_FMT_SGBRG12_1X12: return MEDIA_BUS_FMT_SGRBG12_1X12;
			default: return 0;
			}
		}

		std::string hex(unsigned value) {
			char buffer[16];
			std::snprintf(buffer, sizeof(buffer), "0x%04x", value);
			return buffer;
		}

		bool has_control(int fd, unsigned id) {
			v4l2_queryctrl query{};
			query.id = id;
			return xioctl(fd, VIDIOC_QUERYCTRL, &query) == 0 && !(query.flags & V4L2_CTRL_FLAG_DISABLED);
		}

		bool set_control(int fd, unsigned id, int value) {
			v4l2_control control{};
			control.id = id;
			control.value = value;
			return xioctl(fd, VIDIOC_S_CTRL, &control) == 0;
		}

		bool get_pad_format(int fd, unsigned pad, v4l2_subdev_format& format) {
			format = v4l2_subdev_format{};
			format.which = V4L2_SUBDEV_FORMAT_ACTIVE;
			format.pad = pad;
			return xioctl(fd, VIDIOC_SUBDEV_G_FMT, &format) == 0;
		}

		// Драйвер вправе подменить код на ближайший: принятым считается только наш
		bool set_pad_code(int fd, unsigned pad, unsigned code) {
			v4l2_subdev_format format{};
			if (!get_pad_format(fd, pad, format)) return false;
			format.format.code = code;
			if (xioctl(fd, VIDIOC_SUBDEV_S_FMT, &format) != 0) return false;
			return format.format.code == code;
		}

	} // namespace

	// shortcut: один сенсор CSI на плату (первый m0* и первый rkisp_mainpath), для нескольких нужен граф media-ctl
	std::optional<FV4l2Camera> find_v4l2_camera(const std::string& device) {
		if (device.rfind("/dev/", 0) == 0) {
			std::error_code ec;
			const auto node = fs::canonical(device, ec);
			if (ec) return std::nullopt;
			return describe(node.string(), device, false);
		}

		if (nodes_named(kSensorPrefix, true, "v4l-subdev").empty()) return std::nullopt;
		const auto nodes = nodes_named(device, false, "video");
		if (nodes.empty()) return std::nullopt;
		auto camera = describe(nodes.front(), device, true);
		if (camera) camera->sensor = sensor_model();
		return camera;
	}

	std::vector<FV4l2Camera> list_v4l2_cameras() {
		std::vector<FV4l2Camera> result;

		// USB по адресам by-path, затем узел ISP
		std::error_code ec;
		for (const auto& entry : fs::directory_iterator("/dev/v4l/by-path", ec)) {
			if (auto camera = find_v4l2_camera(entry.path().string())) result.push_back(std::move(*camera));
		}

		if (auto camera = find_v4l2_camera(kCsiNode)) result.push_back(std::move(*camera));

		std::sort(result.begin(), result.end(), [](const auto& a, const auto& b) { return a.device < b.device; });
		return result;
	}

	bool apply_sensor_rotation(bool want_180, std::string& message) {
		const auto sensors = nodes_named(kSensorPrefix, true, "v4l-subdev");
		const auto isps = nodes_named(kIspSubdev, false, "v4l-subdev");
		if (sensors.empty() || isps.empty()) {
			message = "no rkisp sensor subdev";
			return false;
		}

		FFd sensor(sensors.front(), O_RDWR);
		FFd isp(isps.front(), O_RDWR);
		if (!sensor.ok() || !isp.ok()) {
			message = "cannot open " + (sensor.ok() ? isps.front() : sensors.front()) + ": " + std::strerror(errno);
			return false;
		}
		if (!has_control(sensor.fd, V4L2_CID_HFLIP) || !has_control(sensor.fd, V4L2_CID_VFLIP)) {
			message = "sensor " + sensors.front() + " has no flip controls";
			return false;
		}

		v4l2_subdev_format sensor_format{};
		if (!get_pad_format(sensor.fd, 0, sensor_format)) {
			message = std::string("cannot read sensor format: ") + std::strerror(errno);
			return false;
		}

		// Код мозаики сенсора без отражения
		const unsigned native = sensor_format.format.code;
		const unsigned mirrored = mirrored_bayer_code(native);
		if (mirrored == 0) {
			message = "sensor code " + hex(native) + " is not a known Bayer layout";
			return false;
		}

		const int flip = want_180 ? 1 : 0;
		const unsigned target = want_180 ? mirrored : native;
		const bool flips_ok = set_control(sensor.fd, V4L2_CID_HFLIP, flip) && set_control(sensor.fd, V4L2_CID_VFLIP, flip);
		const bool isp_ok = flips_ok && set_pad_code(isp.fd, 0, target);

		if (flips_ok && isp_ok) {
			message = want_180
				? "180 degrees by sensor flip, ISP input " + hex(native) + " -> " + hex(target)
				: "sensor flip off, ISP input " + hex(native);
			return true;
		}

		// Отказ на середине: сенсор и ISP возвращаются в исходное
		const int error = errno;
		set_control(sensor.fd, V4L2_CID_HFLIP, 0);
		set_control(sensor.fd, V4L2_CID_VFLIP, 0);
		set_pad_code(isp.fd, 0, native);
		message = std::string(flips_ok ? "ISP refused code " + hex(target) : "sensor refused flip")
			+ " (" + std::strerror(error) + ")";
		return false;
	}

} // nvr
} // varan
