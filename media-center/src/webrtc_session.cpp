#include "webrtc_session.h"

#include <future>
#include <thread>

#include "signaling_definers.h"

UWebRTCSession::UWebRTCSession(
	std::string client, 
	std::string camera, 
	bool is_sub,
	GstElement* pipeline, 
	GstElement* tee,
	CSendMessage send_callback,
	CRemoveSession remove_callback,
	ULogger* logger
)
	: m_client_id(client)
	, m_camera_name(camera)
	, m_is_sub(is_sub)
	, m_tee(tee)
	, m_send_callback(std::move(send_callback))
	, m_remove_callback(std::move(remove_callback))
	, m_logger(logger)
	, m_is_valid(false)
{
	gst_object_ref(pipeline);
	m_pipeline = pipeline;

	std::ostringstream oss;
	oss << "Successfull created pending new webrtc self:"
		<< "\n\tClient: " << client << "\n\t"
		<< "\n\tCamera: " << camera << "\n\t";
	m_logger->info(oss.str());
}

bool UWebRTCSession::create_branch(const std::string& codec) {
	if (!m_pipeline || !m_tee) {
		std::ostringstream oss;
		oss << "Cannot create branch for the self \"" << m_client_id << "<->" << m_camera_name << "\":"
			<< " Error with building pipeline!"
			<< "\n\tPipeline: " << (!m_pipeline ? "NULL" : "EXISTING")
			<< "\n\tTee: " << (!m_tee ? "NULL" : "EXISTING");
		m_logger->error(oss.str());
		m_is_valid = false;
		return m_is_valid;
	}

	if (!m_send_callback) {
		m_logger->error("Session " + get_session_name() + "cannot be runned, send callback is empty!");
		m_is_valid = false;
		return m_is_valid;
	}

	// Создание всех необходимых элементов
	if (!m_is_sub) {
		m_pay = gst_element_factory_make(codec == std::string("H264") ? "rtph264pay" : "rtph265pay", nullptr);
	}
	else {
		m_pay = nullptr;
	}

	m_queue = gst_element_factory_make("queue", nullptr);
	m_webrtcbin = gst_element_factory_make("webrtcbin", nullptr);

	if (!m_queue || ((!m_pay) && !m_is_sub) || !m_webrtcbin) {
		std::ostringstream oss;
		oss << "Cannot create branch for self " + get_session_name() << ": Error with creation gst elements!"
			<< "\n\tQueue: " << (!m_queue ? "NULL" : "EXISTING")
			<< "\n\tRtph pay: " << (!m_pay ? "NULL" : "EXISTING")
			<< "\n\tWebrtcbin: " << (!m_webrtcbin ? "NULL" : "EXISTING");
		m_logger->error(oss.str());
		m_is_valid = false;
		return m_is_valid;
	}

	// Все настройки на минимальную задержку
	g_object_set(m_queue,
		"leaky", 2,                  
		"max-size-time", 200000000,  // 200 ms
		"max-size-buffers", 0,
		"max-size-bytes", 0,
		nullptr
	);

	// настройки pay для webrtcbin
	if (m_pay) {
		g_object_set(m_pay,
			"pt", 96,
			"config-interval", -1,
			nullptr
		);
	}

	g_object_set(m_webrtcbin,
		"latency", 0,
		"bundle-policy", GST_WEBRTC_BUNDLE_POLICY_MAX_BUNDLE,
		"stun-server", "stun://91.151.186.105:3478",  // свой STUN основной
		nullptr
	);

	// Свой TURN — основной
	gboolean ret_turn = FALSE;
	g_signal_emit_by_name(
		m_webrtcbin,
		"add-turn-server",
		"turn://niac:VniiTest@91.151.186.105:3478?transport=udp",
		&ret_turn
	);
	if (m_logger) m_logger->debug(std::string("added turn server 91.151.186.105:3478: ") + (ret_turn ? "success" : "failed"));

	// Внутренний TURN — запасной (если 172.25.78.169 доступен в локалке)
	g_signal_emit_by_name(
		m_webrtcbin,
		"add-turn-server",
		"turn://niac:VniiTest@172.25.78.169:3478?transport=udp",
		&ret_turn
	);
	if (m_logger) m_logger->debug(std::string("added turn server 172.25.78.169:3478: ") + (ret_turn ? "success" : "failed"));

	if (m_pay) {
		gst_bin_add_many(GST_BIN(m_pipeline), m_queue, m_pay, m_webrtcbin, nullptr);
	}
	else {
		gst_bin_add_many(GST_BIN(m_pipeline), m_queue, m_webrtcbin, nullptr);
	}

	using TGstUniqePad = std::unique_ptr<GstPad, decltype(&gst_object_unref)>;

	// Получаем src пад (выходы) от tee для дальнейшего связывания по цепочке
	m_tee_pad_src = gst_element_request_pad_simple(m_tee, "src_%u");
	if (!m_tee_pad_src) {
		std::ostringstream oss;
		oss << "Cannot create self branch: tee has not any src pads!";
		m_logger->error(oss.str());
		m_is_valid = false;
		return m_is_valid;
	}

	// Получаем входы от очереди
	auto queue_sink_pad = gst_element_get_static_pad(m_queue, "sink");
	if (!queue_sink_pad) {
		std::ostringstream oss;
		oss << "Cannot create self " + get_session_name() + " branch: queue has not any sink pads!";
		m_logger->error(oss.str());
		m_is_valid = false;
		return false;
	}

	// Связываем tee с queue
	auto tee_queue_link = gst_pad_link(m_tee_pad_src, queue_sink_pad);
	if (tee_queue_link != GST_PAD_LINK_OK) {
		m_logger->error("Cannot create self " + get_session_name() + " branch: tee cannot link with queue!");
		m_is_valid = false;
		return m_is_valid;
	}
	gst_object_unref(queue_sink_pad);

	// Линк созданных объектов друг с другом
	auto link_result = m_pay ? gst_element_link_many(m_queue, m_pay, m_webrtcbin, nullptr) : gst_element_link(m_queue, m_webrtcbin);
	if (!link_result) {
		m_logger->error("Cannot create self " + get_session_name() + " branch: there is no link with queue and webrtcbin!");
		m_is_valid = false;
		return m_is_valid;
	}

	// Создаём структуру для передачи в probe
	struct BlockCtx {
		UWebRTCSession* session;
		GstElement* webrtcbin;
	};
	auto* block_ctx = new BlockCtx{ this, m_webrtcbin };

	// Probe который сам снимается когда webrtcbin готов
	gst_pad_add_probe(m_tee_pad_src,
		GST_PAD_PROBE_TYPE_BLOCK_DOWNSTREAM,
		[](GstPad*, GstPadProbeInfo*, gpointer user_data) -> GstPadProbeReturn {
			auto* ctx = static_cast<BlockCtx*>(user_data);

			GstState cur, pend;
			GstStateChangeReturn ret = gst_element_get_state(
				ctx->webrtcbin, &cur, &pend, 0  // неблокирующая проверка
			);

			if (cur >= GST_STATE_PAUSED) {
				// webrtcbin готов — снимаем блок
				delete ctx;
				return GST_PAD_PROBE_REMOVE;
			}

			// Ещё не готов — продолжаем блокировать
			return GST_PAD_PROBE_DROP;
		},
		block_ctx,
		nullptr
	);

	// Привязываем сигналы протокола к только что созданной сессии
	g_signal_handlers_disconnect_by_data(m_webrtcbin, this);
	g_signal_connect(m_webrtcbin, "on-negotiation-needed", G_CALLBACK(&UWebRTCSession::on_negotiation_needed), this);
	g_signal_connect(m_webrtcbin, "on-ice-candidate", G_CALLBACK(&UWebRTCSession::on_ice_candidate), this);

	g_signal_connect(m_webrtcbin, "notify::connection-state", G_CALLBACK(&UWebRTCSession::on_connection_state_changed), this);
	g_signal_connect(m_webrtcbin, "notify::ice-connection-state", G_CALLBACK(&UWebRTCSession::on_ice_state_changed), this);

	// Синхронихируем состояние с основным пайплайном
	gst_element_sync_state_with_parent(m_queue);
	if (m_pay) gst_element_sync_state_with_parent(m_pay);
	gst_element_sync_state_with_parent(m_webrtcbin);

	GstPad* queue_src = gst_element_get_static_pad(m_queue, "src");
	if (queue_src) {
		struct QueueProbeCtx { UWebRTCSession* session; };
		auto* qctx = new QueueProbeCtx{ this };

		gst_pad_add_probe(queue_src,
			static_cast<GstPadProbeType>(
				GST_PAD_PROBE_TYPE_BUFFER |
				GST_PAD_PROBE_TYPE_EVENT_DOWNSTREAM |
				GST_PAD_PROBE_TYPE_QUERY_DOWNSTREAM
			),
			[](GstPad*, GstPadProbeInfo* info, gpointer user_data) -> GstPadProbeReturn {
				auto* ctx = static_cast<QueueProbeCtx*>(user_data);

				if (info->type & GST_PAD_PROBE_TYPE_EVENT_DOWNSTREAM) {
					GstEvent* ev = GST_PAD_PROBE_INFO_EVENT(info);
					ctx->session->get_logger()->debug(
						"[queue→webrtcbin] EVENT: " + std::string(GST_EVENT_TYPE_NAME(ev))
					);
					if (GST_EVENT_TYPE(ev) == GST_EVENT_CAPS) {
						GstCaps* caps = nullptr;
						gst_event_parse_caps(ev, &caps);
						gchar* s = gst_caps_to_string(caps);
						ctx->session->get_logger()->info(
							"[queue→webrtcbin] CAPS: " + std::string(s)
						);
						g_free(s);
					}
				}

				if (info->type & GST_PAD_PROBE_TYPE_BUFFER) {
					ctx->session->get_logger()->info(
						"[queue→webrtcbin] BUFFER arrived — removing probe"
					);
					delete ctx;
					return GST_PAD_PROBE_REMOVE;
				}

				return GST_PAD_PROBE_OK;
			},
			qctx,
			nullptr
		);
		gst_object_unref(queue_src);
	}

	std::string message = "Branch webrtc session " + get_session_name() + " has been created!";
	boost::json::object opened_msg = UWebRTCSession::make_json(true, SIG_TYPE_CONNECT, message);
	m_logger->info(message);

	// Проверяем состояние webrtcbin
	GstState current, pending;
	GstStateChangeReturn ret;
	ret = gst_element_get_state(m_webrtcbin, &current, &pending, GST_SECOND);

	switch (ret) {
	case GST_STATE_CHANGE_SUCCESS:
		m_logger->info("webrtcbin state: " + std::string(gst_element_state_get_name(current)));
		break;
	case GST_STATE_CHANGE_ASYNC:
		m_logger->info("webrtcbin state change in progress, current: " + std::string(gst_element_state_get_name(current))
			+ ", pending: " + std::string(gst_element_state_get_name(pending)));
		break;
	case GST_STATE_CHANGE_FAILURE:
		m_logger->error("Failed to change webrtcbin state!");
		break;
	default:
		m_logger->warn("Unknown state change return!");
		break;
	}

	m_is_valid = true;

	// Принудительно тригерим negotiation из GLib main loop
	// чтобы не зависеть от автоматического on-negotiation-needed
	/*struct NegotiationCtx {
		GstElement* webrtcbin;
		UWebRTCSession* session;
	};

	auto* neg_ctx = new NegotiationCtx{ m_webrtcbin, this };

	g_main_context_invoke(nullptr,
		[](gpointer data) -> gboolean {
			auto* ctx = static_cast<NegotiationCtx*>(data);

			if (!ctx->session->is_valid() || ctx->session->m_offer_started.exchange(true)) {
				delete ctx;
				return G_SOURCE_REMOVE;
			}

			// Ждём PLAYING прямо здесь — мы уже в GLib main loop
			GstState current, pending;
			GstStateChangeReturn ret = gst_element_get_state(
				ctx->webrtcbin, &current, &pending, 3 * GST_SECOND
			);

			if (ret == GST_STATE_CHANGE_FAILURE || current < GST_STATE_PAUSED) {
				ctx->session->get_logger()->error(
					"Manual negotiation: webrtcbin not ready, state=" +
					std::string(gst_element_state_get_name(current))
				);
				// Сбрасываем флаг чтобы можно было попробовать снова
				ctx->session->m_offer_started.store(false);
				delete ctx;
				return G_SOURCE_REMOVE;
			}

			ctx->session->get_logger()->debug(
				"Manual negotiation trigger for " + ctx->session->get_session_name()
			);

			auto promise = gst_promise_new_with_change_func(
				&UWebRTCSession::on_offer_created, ctx->session, nullptr
			);
			g_signal_emit_by_name(ctx->webrtcbin, "create-offer", nullptr, promise);

			delete ctx;
			return G_SOURCE_REMOVE;
		},
		neg_ctx
	);
	*/

	return m_is_valid;
}

void UWebRTCSession::teardown() {
	if (!m_webrtcbin) {
		m_logger->error("teardown(): cannot do teardown: webrtcbin is NULL!");
		return;
	}

	if (!g_main_context_is_owner(g_main_context_default())) {
		m_logger->debug("teardown(): not in main thread, invoking via g_main_context");

		std::promise<void> done;
		auto future = done.get_future();

		struct Ctx {
			UWebRTCSession* self;
			std::promise<void> done;
		};
		auto* ctx = new Ctx{ this, std::move(done) };

		g_main_context_invoke(
			g_main_context_default(),
			+[](gpointer data) -> gboolean {
				auto* ctx = static_cast<Ctx*>(data);
				ctx->self->teardown(); // рекурсивный вызов — теперь в main thread
				ctx->done.set_value();
				delete ctx;
				return G_SOURCE_REMOVE;
			},
			ctx
		);

		// Ждём завершения с таймаутом
		if (future.wait_for(std::chrono::seconds(5)) == std::future_status::timeout) {
			m_logger->error("teardown(): timeout waiting for main thread!");
		}
		return;
	}

	if (!m_is_valid) {
		return;
	}
	m_is_valid = false;

	m_logger->debug("teardown(): destroying session: " + m_client_id);

	cancel_connection_timeout();
	// Отключение сигналов
	g_signal_handlers_disconnect_by_data(m_webrtcbin, this);

	// блокирование ветки
	if (m_tee_pad_src) {
		gst_pad_add_probe(m_tee_pad_src, GST_PAD_PROBE_TYPE_BLOCK_DOWNSTREAM,
			[](GstPad*, GstPadProbeInfo*, gpointer) { return GST_PAD_PROBE_REMOVE; }, nullptr, nullptr);

		GstPad* queue_sink = gst_element_get_static_pad(m_queue, "sink");
		if (queue_sink) {
			gst_pad_unlink(m_tee_pad_src, queue_sink);
			gst_object_unref(queue_sink);
		}

		gst_element_release_request_pad(m_tee, m_tee_pad_src);
		gst_object_unref(m_tee_pad_src);
		m_tee_pad_src = nullptr;
	}

	// Удаление трансиверов
	GArray* transceivers = nullptr;
	g_signal_emit_by_name(m_webrtcbin, "get-transceivers", &transceivers);
	if (transceivers) {
		for (guint i = 0; i < transceivers->len; ++i) {

			GstWebRTCRTPTransceiver* trans = g_array_index(transceivers, GstWebRTCRTPTransceiver*, i);
			if (!trans) { continue; }

			g_object_set(trans, "direction", GST_WEBRTC_RTP_TRANSCEIVER_DIRECTION_INACTIVE, NULL);
		}

		g_array_unref(transceivers);
	}

	// выключение wbrtcbin через NULL, должен удалить все висячие дексрипторы
	if (m_webrtcbin) {
		gst_element_set_state(m_webrtcbin, GST_STATE_NULL);

		// Ждём дольше секунды: именно здесь освобождаются сокеты ICE,
		// а незавершённый переход означает утечк
		const auto ret = gst_element_get_state(m_webrtcbin, nullptr, nullptr, 5 * GST_SECOND);
		if (ret != GST_STATE_CHANGE_SUCCESS) {
			m_logger->warn("teardown(): webrtcbin didn't reach NULL state, ICE sockets may leak");
		}
	}

	if (m_pay) {
		gst_element_set_state(m_pay, GST_STATE_NULL);
		gst_element_get_state(m_pay, nullptr, nullptr, GST_SECOND);
	}

	if (m_queue) {
		gst_element_set_state(m_queue, GST_STATE_NULL);
		gst_element_get_state(m_queue, nullptr, nullptr, GST_SECOND);
	}

	// очистка самого пайплайна
	if (m_pipeline) {
		if (GST_IS_BIN(m_pipeline)) {
			if (m_pay) {
				gst_bin_remove_many(GST_BIN(m_pipeline), m_webrtcbin, m_pay, m_queue, nullptr);
			}
			else {
				gst_bin_remove_many(GST_BIN(m_pipeline), m_webrtcbin, m_queue, nullptr);
			}
		}

		gst_object_unref(m_pipeline);
		m_pipeline = nullptr;
	}

	m_webrtcbin = nullptr;
	m_pay = nullptr;
	m_queue = nullptr;
	m_tee = nullptr;

	m_logger->debug("Session " + m_client_id + " destroyed completely!");
}


bool UWebRTCSession::make_offer(const boost::json::object& message, std::string& description) {
	auto sdp_v = message.if_contains("sdp");
	if (!sdp_v || !sdp_v->is_string()) {
		description = get_session_name() + ": No SDP in recieved offer";
		return false;
	}
	else {
		m_logger->receive(get_session_name() + ": Received SDP offer:\n\t" + sdp_v->as_string().data());
	}

	std::string sdp_str = sdp_v->as_string().c_str();

	GstSDPMessage* sdp = nullptr;
	gst_sdp_message_new(&sdp);
	gst_sdp_message_parse_buffer(reinterpret_cast<const guint8*>(sdp_str.c_str()), sdp_str.size(), sdp);

	GstWebRTCSessionDescription* offer = gst_webrtc_session_description_new(GST_WEBRTC_SDP_TYPE_OFFER, sdp);

	// set-remote-description через Promise — создаём answer только после завершения
	GstPromise* promise = gst_promise_new_with_change_func(
		[](GstPromise* promise, gpointer user_data) {
			auto* self = static_cast<UWebRTCSession*>(user_data);
			gst_promise_unref(promise);

			GstPromise* answer_promise = gst_promise_new_with_change_func(
				&UWebRTCSession::on_offer_created, self, nullptr);
			g_signal_emit_by_name(self->get_webrtcbin_element(),
				"create-answer", nullptr, answer_promise);
		},
		this, nullptr
	);

	g_signal_emit_by_name(m_webrtcbin, "set-remote-description", offer, promise);
	gst_webrtc_session_description_free(offer);

	description = "Successfully processed offer, creating answer...";
	return true;
}

bool UWebRTCSession::create_answer(const boost::json::object& message, std::string& description) {
	auto sdp_v = message.if_contains("sdp");
	if (!sdp_v || !sdp_v->is_string()) {
		description = get_session_name() + ": No SDP in recieved offer";
		return false;
	}
	else {
		m_logger->receive(get_session_name() + ": Recieved SDP answer:\n\t" + sdp_v->as_string().data());
	}

	std::string sdp_str = sdp_v->as_string().c_str();

	GstSDPMessage* sdp = nullptr;
	gst_sdp_message_new(&sdp);
	gst_sdp_message_parse_buffer(reinterpret_cast<const guint8*>(sdp_str.c_str()), sdp_str.size(), sdp);

	GstWebRTCSessionDescription* answer = gst_webrtc_session_description_new(GST_WEBRTC_SDP_TYPE_ANSWER, sdp);

	g_signal_emit_by_name(m_webrtcbin, "set-remote-description", answer, nullptr);
	gst_webrtc_session_description_free(answer);
	description = "Successfully created answer!";
	return true;
}

bool UWebRTCSession::add_ice_candidate(const boost::json::object& message, std::string& description) {
	auto cand_v = message.if_contains("candidate");
	auto line_v = message.if_contains("sdpMLineIndex");
	auto mid_v = message.if_contains("sdpMid");

	std::string candidate;
	std::string sdpMid;
	int mline_index = 0;

	bool fail = false;

	if (cand_v && cand_v->is_string()) {
		candidate = cand_v->as_string();
	}
	else {
		fail = true;
	}

	if (line_v && line_v->is_int64()) {
		mline_index = static_cast<int>(line_v->as_int64());
	}
	else {
		fail = true;
	}

	if (mid_v && mid_v->is_string()) {
		sdpMid = mid_v->as_string();
	}

	if (fail) {
		description = get_session_name() + ": Cannot add candidate!";
		return false;
	}
	else {
		std::ostringstream oss;
		oss << "Recieve ICE candidate:"
			<< "\n\tcandidate:" << candidate
			<< "\n\tmline_index:" << mline_index
			<< "\n\tsdpMid:" << (sdpMid.empty() ? "NONE" : sdpMid);
		m_logger->receive(oss.str());
	}

	if (candidate.find(".local") != std::string::npos) {
		description = get_session_name() + ": Ignore mDNS candidate: " + candidate;
		m_logger->warn(description);
		return true;
	}

	g_signal_emit_by_name(m_webrtcbin, "add-ice-candidate", mline_index, candidate.c_str());
	description = get_session_name() + ": Added ICE candidate!";
	return true;
}

void UWebRTCSession::on_negotiation_needed(GstElement* webrtcbin, gpointer data) {
	auto self = static_cast<UWebRTCSession*>(data);
	if (!self) {
		std::cout << color::red << "[No Logger Error] [UCamera] Negotiation needed - nullptr with camera!\n" << color::reset;
		return;
	}
	if (!webrtcbin) {
		self->get_logger()->error("Negotioation needed: Session" + self->get_session_name() + " not valid webrtcbin!");
		return;
	}

	if (self->m_offer_started.exchange(true)) {
		self->get_logger()->debug("on_negotiation_needed: offer already in progress, skipping");
		return;
	}

	self->get_logger()->debug("Negotiation needed: Session " + self->get_session_name() + " - creating offer");

	// Запускаем таймаут — если за 10 сек не подключился, закрываем сессию
	//if (self->m_connection_timeout_id == 0) {
	//	self->m_connection_timeout_id = g_timeout_add_seconds(10, &UWebRTCSession::on_connection_timeout, self);
	//	self->get_logger()->debug("Connection timeout timer started for " + self->get_session_name());
	//}

	auto promise = gst_promise_new_with_change_func(&UWebRTCSession::on_offer_created, self, nullptr);
	if (!promise) {
		self->m_logger->error("Negotiation needed: Session " + self->get_session_name() + " - nullptr with promise!");
		return;
	}

	g_signal_emit_by_name(webrtcbin, "create-offer", nullptr, promise);
}

void UWebRTCSession::start_offer_timeout() {
	
}

void UWebRTCSession::on_offer_created(GstPromise* promise, gpointer data) {
	auto self = static_cast<UWebRTCSession*>(data);
	if (!self) {
		std::cout << color::red << "[UCamera] on_offer_created - nullptr camera\n" << color::reset;
		gst_promise_unref(promise);  // обязательно unref даже при ошибке
		return;
	}

	const GstStructure* reply = gst_promise_get_reply(promise);
	if (!reply) {
		self->get_logger()->error(self->get_session_name() + ": on_offer_created - cannot get reply");
		gst_promise_unref(promise);
		return;
	}

	GstWebRTCSessionDescription* offer = nullptr;
	// Пробуем сначала "offer", потом "answer"
	if (!gst_structure_get(reply, "offer", GST_TYPE_WEBRTC_SESSION_DESCRIPTION, &offer, nullptr) || !offer) {
		if (!gst_structure_get(reply, "answer", GST_TYPE_WEBRTC_SESSION_DESCRIPTION, &offer, nullptr) || !offer) {
			self->get_logger()->error(self->get_session_name() + ": on_offer_created - cannot get offer/answer from reply");
			gst_promise_unref(promise);
			return;
		}
	}

	// Устанавливаем локальное описание (offer)
	g_signal_emit_by_name(self->get_webrtcbin_element(), "set-local-description", offer, nullptr);

	// Теперь можно unref промис, reply уже получен
	gst_promise_unref(promise);

	gchar* sdp_str = gst_sdp_message_as_text(offer->sdp);
	if (!sdp_str) {
		self->get_logger()->error(self->get_session_name() + ": on_offer_created - cannot convert SDP to text");
		gst_webrtc_session_description_free(offer);
		return;
	}

	boost::json::object offer_msg = self->make_json(true, "offer", "Created sdp offer!");
	offer_msg[SIG_SDP] = std::string(sdp_str);

	g_free(sdp_str);

	std::string serialized_offer_msg = boost::json::serialize(offer_msg);
	self->send_message(serialized_offer_msg);

	self->get_logger()->info(self->get_session_name() + ": created and sent sdp offer!\n\t" + serialized_offer_msg);

	gst_webrtc_session_description_free(offer);
}

void UWebRTCSession::send_message(const std::string& msg) {
	m_send_callback(msg);
}

void UWebRTCSession::send_close_request(const std::string& client_id, std::string& description) {
	if (m_close_requested.exchange(true)) {
		return;
	}
	if (!m_remove_callback) {
		description = "Internal error, there is no callback to remove self!";
		return;
	}

	m_logger->warn("session with " + m_client_id + " closing...");

	bool ret = m_remove_callback(client_id, description);
	if (m_send_callback) {
		auto msg = boost::json::serialize(make_json(ret, "connection", description));
		m_send_callback(msg);
	}
}

void UWebRTCSession::on_ice_candidate(GstElement* webrtcbin, guint mlineindex, gchar* candidate, gpointer data) {
	auto self = static_cast<UWebRTCSession*>(data);

	// Добавить эту строку:
	self->get_logger()->debug("Sending ICE candidate to client: " + std::string(candidate));

	boost::json::object ice_msg = self->make_json(true, "ice", "Sending Ice candidate");
	ice_msg[SIG_ICE_CANDIDATE] = std::string(candidate);
	ice_msg[SIG_ICE_LINE_INDEX] = static_cast<int>(mlineindex);

	std::string serialized_ice_message = boost::json::serialize(ice_msg);
	self->send_message(serialized_ice_message);
}

void UWebRTCSession::on_connection_state_changed(GObject* obj, GParamSpec*, gpointer user_data)
{
	auto self = static_cast<UWebRTCSession*>(user_data);

	GstWebRTCPeerConnectionState state;
	g_object_get(obj, "connection-state", &state, nullptr);

	switch (state)
	{
	case GST_WEBRTC_PEER_CONNECTION_STATE_FAILED:
	case GST_WEBRTC_PEER_CONNECTION_STATE_CLOSED: {
		std::string desc = "webrtc connection with" + self->get_client_id() + " was closed!";
		self->send_close_request(self->get_client_id(), desc);
		self->get_logger()->debug(desc);
		break;
	}
	case GST_WEBRTC_PEER_CONNECTION_STATE_CONNECTED:
		self->set_connected(true);
		self->get_logger()->debug("webrtc connection established!");
		break;
	case GST_WEBRTC_PEER_CONNECTION_STATE_NEW:
		self->get_logger()->debug("new webrtc connection with " + self->get_client_id() + " requested!");
		break;
	case GST_WEBRTC_PEER_CONNECTION_STATE_CONNECTING:
		self->get_logger()->debug("connecting with " + self->get_client_id());
		break;
	default:
		break;
	}
}

void UWebRTCSession::on_connection_state_notify(GObject* object, GParamSpec*, gpointer user_data)
{
	gboolean* closed_flag = static_cast<gboolean*>(user_data);

	GstWebRTCPeerConnectionState state;
	g_object_get(object, "connection-state", &state, NULL);

	if (state == GST_WEBRTC_PEER_CONNECTION_STATE_CLOSED ||
		state == GST_WEBRTC_PEER_CONNECTION_STATE_FAILED)
	{
		*closed_flag = TRUE;
	}
}

void UWebRTCSession::on_ice_state_changed(GObject* obj, GParamSpec*, gpointer user_data)
{
	auto self = static_cast<UWebRTCSession*>(user_data);

	GstWebRTCICEConnectionState state;
	g_object_get(obj, "ice-connection-state", &state, nullptr);

	switch (state) {
		case GST_WEBRTC_ICE_CONNECTION_STATE_CLOSED:
		case GST_WEBRTC_ICE_CONNECTION_STATE_FAILED: {
			std::string desc = "closed ICE connection with " + self->get_client_id() + "!";
			self->send_close_request(self->get_client_id(), desc);
			self->get_logger()->error(desc);
			break;
		}
		case GST_WEBRTC_ICE_CONNECTION_STATE_DISCONNECTED:
			self->get_logger()->debug("ICE disconnected from " + self->get_client_id());
			break;
		case GST_WEBRTC_ICE_CONNECTION_STATE_CHECKING:
			self->get_logger()->debug("ICE changed state to checking with " + self->get_client_id());
			break;
		case GST_WEBRTC_ICE_CONNECTION_STATE_COMPLETED:
			self->get_logger()->debug("ICE changed state to completed with " + self->get_client_id());
			break;
		case GST_WEBRTC_ICE_CONNECTION_STATE_CONNECTED:
			self->get_logger()->info("ICE successfully connected to " + self->get_client_id());
			break;
		default:
			break;
	}
}

gboolean UWebRTCSession::on_connection_timeout(gpointer user_data) {
	auto* self = static_cast<UWebRTCSession*>(user_data);
	if (!self) return G_SOURCE_REMOVE;

	self->m_connection_timeout_id = 0; // таймер уже сработал, не надо отменять

	if (self->m_is_connected.load()) {
		// Успели подключиться — всё хорошо
		self->get_logger()->debug("Connection timeout fired but already connected: " + self->get_session_name());
		return G_SOURCE_REMOVE;
	}

	self->get_logger()->warn("Connection timeout! No connection in 10s, closing session: " + self->get_session_name());

	self->m_timeout_triggered.store(true);
	std::string desc;
	self->send_close_request(self->get_client_id(), desc);


	return G_SOURCE_REMOVE;
}

void UWebRTCSession::cancel_connection_timeout() {
	if (m_connection_timeout_id != 0) {
		g_source_remove(m_connection_timeout_id);
		m_connection_timeout_id = 0;
		m_logger->debug("Connection timeout cancelled for " + get_session_name());
	}
}

boost::json::object UWebRTCSession::make_json(
	bool successed,
	const std::string& type,
	const std::string& description
) {
	boost::json::object message;
	message[SIG_TYPE] = type;
	message[SIG_SENDER] = SIG_SENDER_CAMERA;
	message[SIG_RET] = successed ? SIG_RET_SUCCESS : SIG_RET_FAULT;
	message[SIG_CLIENT] = m_client_id;
	message[SIG_CAMERA] = m_camera_name;
	message[SIG_DECRIPTION] = description;
	return message;
}

std::string UWebRTCSession::get_session_name() {
	std::ostringstream oss;
	oss << "\"" << m_client_id << "<->" << m_camera_name << "\"";
	return oss.str();
}

GstElement* UWebRTCSession::get_webrtcbin_element() {
	return m_webrtcbin;
}

bool UWebRTCSession::is_valid() {
	return m_is_valid;
}

std::string UWebRTCSession::get_client_id() {
	return m_client_id;
}

ULogger* UWebRTCSession::get_logger() {
	return m_logger;
}

bool UWebRTCSession::is_timeout_triggered() const { return m_timeout_triggered.load(); }

void UWebRTCSession::set_connected(bool is_connected) {
	m_is_connected = is_connected;
	if (is_connected) {
		cancel_connection_timeout(); // соединение есть — таймер больше не нужен
	}
}