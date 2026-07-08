#include "gateway/grpc-ingress.h"
#include "gateway/log.h"

#include <string>

#include <grpcpp/grpcpp.h>

#include "frame-ingress.grpc.pb.h"

namespace varan {
    namespace gateway {

        namespace rpc = varan::gateway::rpc;

        namespace {

            FFrameMessage from_proto(const rpc::FrameRequest& req) {
                FFrameMessage msg;
                msg.ver = req.ver();
                msg.id = req.id();
                msg.ts = req.ts();
                msg.width = req.width();
                msg.height = req.height();
                msg.format = req.format();
                msg.image = req.image();

                msg.dets.reserve(req.dets_size());
                for (const auto& d : req.dets()) {
                    FDetection det;
                    det.cid = d.cid();
                    det.cls = d.cls();
                    det.cf = d.cf();
                    for (int i = 0; i < 4 && i < d.box_size(); ++i) {
                        det.box[i] = d.box(i);
                    }
                    if (!d.scls().empty()) {
                        det.scls = d.scls();
                    }
                    msg.dets.push_back(std::move(det));
                }
                return msg;
            }

            rpc::FrameReply to_reply(const FSubmitResult& r) {
                rpc::FrameReply reply;
                reply.set_ver(r.ver);
                reply.set_accepted(r.status == ESubmitStatus::Accepted);

                if (r.status == ESubmitStatus::Accepted) {
                    reply.set_transport(r.transport);
                    reply.set_wire_size(r.wire_size);
                }
                else if (r.status == ESubmitStatus::UnsupportedVersion) {
                    std::string err = r.error + " (supported:";
                    for (int v : r.supported) {
                        err += " " + std::to_string(v);
                    }
                    err += ")";
                    reply.set_error(err);
                }
                else {
                    reply.set_error(r.error);
                }
                return reply;
            }

            // Реализация сервиса. Одну неверную версию/кадр не роняем в стрим —
            // отвечаем accepted=false и продолжаем читать поток.
            class UFrameIngressServiceImpl final : public rpc::FrameIngress::Service {
            public:
                explicit UFrameIngressServiceImpl(IFrameSink& sink) : m_sink(sink) {}

                grpc::Status SendFrame(
                    grpc::ServerContext*,
                    const rpc::FrameRequest* req,
                    rpc::FrameReply* reply) override
                {
                    *reply = to_reply(m_sink.submit_frame(from_proto(*req)));
                    return grpc::Status::OK;
                }

                grpc::Status StreamFrames(
                    grpc::ServerContext*,
                    grpc::ServerReaderWriter<rpc::FrameReply, rpc::FrameRequest>* stream) override
                {
                    rpc::FrameRequest req;
                    while (stream->Read(&req)) {
                        auto reply = to_reply(m_sink.submit_frame(from_proto(req)));
                        if (!stream->Write(reply)) {
                            break;
                        }
                        req.Clear();
                    }
                    return grpc::Status::OK;
                }

            private:
                IFrameSink& m_sink;
            };

        } // namespace

        UGrpcIngress::UGrpcIngress(IFrameSink& sink, std::uint16_t port, std::size_t max_message_bytes)
            : m_sink(sink)
            , m_port(port)
            , m_max_message_bytes(max_message_bytes)
        {}

        UGrpcIngress::~UGrpcIngress() {
            stop();
        }

        void UGrpcIngress::start() {
            if (m_server) {
                return;
            }

            auto service = std::make_unique<UFrameIngressServiceImpl>(m_sink);
            std::string addr = "0.0.0.0:" + std::to_string(m_port);

            grpc::ServerBuilder builder;
            builder.AddListeningPort(addr, grpc::InsecureServerCredentials());
            builder.SetMaxReceiveMessageSize(static_cast<int>(m_max_message_bytes));
            builder.SetMaxSendMessageSize(static_cast<int>(m_max_message_bytes));
            builder.RegisterService(service.get());

            m_service = std::move(service);
            m_server = builder.BuildAndStart();

            ULog::info("grpc", "Frame ingress (gRPC) on " + addr);
            m_thread = std::thread([this] { m_server->Wait(); });
        }

        void UGrpcIngress::stop() {
            if (m_server) {
                m_server->Shutdown();
            }
            if (m_thread.joinable()) {
                m_thread.join();
            }
            m_server.reset();
            m_service.reset();
        }

    } // namespace gateway
} // namespace varan
