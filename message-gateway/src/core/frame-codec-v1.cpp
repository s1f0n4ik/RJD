#include "gateway/core/frame-codec-v1.h"

#include <boost/json.hpp>

namespace varan {
    namespace gateway {

        namespace json = boost::json;

        namespace {

            // Длина заголовка префиксом big-endian, как требует протокол.
            void put_u32_be(std::string& out, std::uint32_t v) {
                out.push_back(static_cast<char>((v >> 24) & 0xFF));
                out.push_back(static_cast<char>((v >> 16) & 0xFF));
                out.push_back(static_cast<char>((v >> 8) & 0xFF));
                out.push_back(static_cast<char>(v & 0xFF));
            }

            json::object build_header(const FFrameMessage& msg) {
                json::object header;
                header["ver"] = 1;
                header["type"] = "frame";
                header["id"] = msg.id;
                header["ts"] = msg.ts;
                if (!msg.camera_id.empty()) {
                    header["cam"] = msg.camera_id;
                }

                json::object img;
                img["width"] = msg.width;
                img["height"] = msg.height;
                img["format"] = msg.format;
                header["img"] = std::move(img);

                json::array dets;
                dets.reserve(msg.dets.size());
                for (const auto& d : msg.dets) {
                    json::object det;
                    det["cid"] = d.cid;
                    det["cls"] = d.cls;
                    det["cf"] = d.cf;
                    det["box"] = json::array{ d.box[0], d.box[1], d.box[2], d.box[3] };
                    if (d.scls) {
                        det["scls"] = *d.scls;
                    }
                    dets.push_back(std::move(det));
                }
                header["dets"] = std::move(dets);
                return header;
            }

        } // namespace

        FEncodeResult UFrameCodecV1::encode_frame(const FFrameMessage& msg) const {
            FEncodeResult result;

            if (msg.image.empty()) {
                result.error = "empty image payload";
                return result;
            }
            if (msg.format.empty()) {
                result.error = "missing image format";
                return result;
            }

            std::string header = json::serialize(build_header(msg));

            std::string wire;
            wire.reserve(4 + header.size() + msg.image.size());
            put_u32_be(wire, static_cast<std::uint32_t>(header.size()));
            wire += header;
            wire += msg.image;

            result.ok = true;
            result.binary = true;
            result.wire = std::move(wire);
            return result;
        }

        std::string UFrameCodecV1::encode_heartbeat(std::int64_t ts) const {
            json::object o;
            o["ver"] = 1;
            o["type"] = "heartbeat";
            o["ts"] = ts;
            return json::serialize(o);
        }

    } // namespace gateway
} // namespace varan
