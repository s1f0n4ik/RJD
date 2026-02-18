#include "webrtc_session.h"

#include <gst/webrtc/webrtc.h>

#include "signaling_definers.h"

UWebRTCSession::UWebRTCSession(
	std::string client, 
	std::string camera, 
	bool is_sub,
	GstElement* pipeline, 
	GstElement* tee,
	CSendMessage send_callback,
	ULogger& logger
)
	: m_client_id(client)
	, m_camera_name(camera)
	, m_is_sub(is_sub)
	, m_pipeline(pipeline)
	, m_tee(tee)
	, m_send_callback(std::move(send_callback))
	, m_logger(logger)
	, m_is_valid(false)
{
	std::ostringstream oss;
	oss << "Successfull created pending new webrtc session:"
		<< "\n\tClient: " << client << "\n\t"
		<< "\n\tCamera: " << camera << "\n\t";
	m_logger.info(oss.str());
}

UWebRTCSession::~UWebRTCSession() {
	if (!m_is_valid) {
		return;
	}

	teardown();
}

bool UWebRTCSession::create_branch(const std::string& codec) {
	if (!m_pipeline || !m_tee) {
		std::ostringstream oss;
		oss << "Cannot create branch for the session \"" << m_client_id << "<->" << m_camera_name << "\":"
			<< " Error with building pipeline!"
			<< "\n\tPipeline: " << (!m_pipeline ? "NULL" : "EXISTING")
			<< "\n\tTee: " << (!m_tee ? "NULL" : "EXISTING");
		m_logger.error(oss.str());
		m_is_valid = false;
		return m_is_valid;
	}

	if (!m_send_callback) {
		m_logger.error("Session " + get_session_name() + "cannot be runned, send callback is empty!");
		m_is_valid = false;
		return m_is_valid;
	}

	// Создание всех необходимых элементов
	m_queue = gst_element_factory_make("queue", nullptr);
	if (!m_is_sub) m_pay = gst_element_factory_make(codec == std::string("H264") ? "rtph264pay" : "rtph265pay", nullptr);
	m_webrtcbin = gst_element_factory_make("webrtcbin", nullptr);

	if (!m_queue || ((!m_pay) && !m_is_sub) || !m_webrtcbin) {
		std::ostringstream oss;
		oss << "Cannot create branch for session " + get_session_name() << ": Error with creation gst elements!"
			<< "\n\tQueue: " << (!m_queue ? "NULL" : "EXISTING")
			<< "\n\tRtph pay: " << (!m_pay ? "NULL" : "EXISTING")
			<< "\n\tWebrtcbin: " << (!m_webrtcbin ? "NULL" : "EXISTING");
		m_logger.error(oss.str());
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
		"do-nack", TRUE,
		nullptr
	);

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
		oss << "Cannot create session branch: tee has not any src pads!";
		m_logger.error(oss.str());
		m_is_valid = false;
		return m_is_valid;
	}

	// Получаем входы от очереди
	auto queue_sink_pad = gst_element_get_static_pad(m_queue, "sink");
	if (!queue_sink_pad) {
		std::ostringstream oss;
		oss << "Cannot create session " + get_session_name() + " branch: queue has not any sink pads!";
		m_logger.error(oss.str());
		m_is_valid = false;
		return false;
	}

	// Связываем tee с queue
	auto tee_queue_link = gst_pad_link(m_tee_pad_src, queue_sink_pad);
	if (tee_queue_link != GST_PAD_LINK_OK) {
		m_logger.error("Cannot create session " + get_session_name() + " branch: tee cannot link with queue!");
		m_is_valid = false;
		return m_is_valid;
	}
	gst_object_unref(queue_sink_pad);

	// Линк созданных объектов друг с другом
	auto link_result = m_pay ? gst_element_link_many(m_queue, m_pay, m_webrtcbin, nullptr) : gst_element_link(m_queue, m_webrtcbin);
	if (!link_result) {
		m_logger.error("Cannot create session " + get_session_name() + " branch: there is no link with queue and webrtcbin!");
		m_is_valid = false;
		return m_is_valid;
	}

	// Привязываем сигналы протокола к только что созданной сессии
	g_signal_connect(m_webrtcbin, "on-negotiation-needed", G_CALLBACK(&UWebRTCSession::on_negotiation_needed), this);
	g_signal_connect(m_webrtcbin, "on-ice-candidate", G_CALLBACK(&UWebRTCSession::on_ice_candidate), this);

	// Синхронихируем состояние с основным пайплайном
	gst_element_sync_state_with_parent(m_queue);
	if (m_pay) gst_element_sync_state_with_parent(m_pay);
	gst_element_sync_state_with_parent(m_webrtcbin);

	std::string message = "Branch session " + get_session_name() + " has been created!";
	boost::json::object opened_msg = UWebRTCSession::make_json(true, SIG_TYPE_CONNECT, message);
	m_logger.info(message);

	return true;
}

void UWebRTCSession::teardown() {
	// Блокировка ветки
	gst_pad_add_probe(m_tee_pad_src, GST_PAD_PROBE_TYPE_BLOCK_DOWNSTREAM, nullptr, nullptr, nullptr);

	gst_element_set_state(m_webrtcbin, GST_STATE_NULL);
	if (m_pay) gst_element_set_state(m_pay, GST_STATE_NULL);
	gst_element_set_state(m_queue, GST_STATE_NULL);

	GstPad* queue_sink = gst_element_get_static_pad(m_queue, "sink");
	if (!gst_pad_unlink(m_tee_pad_src, queue_sink)) {
		m_logger.warn(get_session_name() + ": cannot unlink tee and queue when teardown!");
	}
	gst_object_unref(queue_sink);

	// Уничтожение src pad в этой херне
	gst_element_release_request_pad(m_tee, m_tee_pad_src);
	gst_object_unref(m_tee_pad_src);
	m_tee_pad_src = nullptr;

	if (m_pay) {
		gst_bin_remove_many(GST_BIN(m_pipeline), m_webrtcbin, m_pay, m_queue, nullptr);
	}
	else {
		gst_bin_remove_many(GST_BIN(m_pipeline), m_webrtcbin, m_queue, nullptr);
	}
	m_is_valid = false;
}

bool UWebRTCSession::make_offer(const boost::json::object& message, std::string& description) {
	auto sdp_v = message.if_contains("sdp");
	if (!sdp_v || !sdp_v->is_string()) {
		description = get_session_name() + ": No SDP in recieved offer";
		return false;
	}
	else {
		m_logger.receive(get_session_name() + ": Received SDP offer:\n\t" + sdp_v->as_string().data());
	}

	std::string sdp_str = sdp_v->as_string().c_str();

	GstSDPMessage* sdp = nullptr;
	gst_sdp_message_new(&sdp);
	gst_sdp_message_parse_buffer(reinterpret_cast<const guint8*>(sdp_str.c_str()), sdp_str.size(), sdp);

	GstWebRTCSessionDescription* offer = gst_webrtc_session_description_new(GST_WEBRTC_SDP_TYPE_OFFER, sdp);

	g_signal_emit_by_name(m_webrtcbin, "set-remote-description", offer, nullptr);
	gst_webrtc_session_description_free(offer);

	g_signal_emit_by_name(m_webrtcbin, "create-answer", nullptr);
	description = "Successfully created offer!";
	return true;
}

bool UWebRTCSession::create_answer(const boost::json::object& message, std::string& description) {
	auto sdp_v = message.if_contains("sdp");
	if (!sdp_v || !sdp_v->is_string()) {
		description = get_session_name() + ": No SDP in recieved offer";
		return false;
	}
	else {
		m_logger.receive(get_session_name() + ": Recieved SDP answer:\n\t" + sdp_v->as_string().data());
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
		fail = false;
	}

	if (line_v && line_v->is_int64()) {
		mline_index = static_cast<int>(line_v->as_int64());
	}
	else {
		fail = false;
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
			<< "\n\tsdpMid:" << sdpMid.empty() ? "NONE" : sdpMid;
		m_logger.receive(oss.str());
	}

	if (candidate.find(".local") != std::string::npos) {
		description = get_session_name() + ": Ignore mDNS candidate: " + candidate;
		m_logger.warn(description);
		return true;
	}
	else {
		g_signal_emit_by_name(m_webrtcbin, "add-ice-candidate", mline_index, candidate.c_str());
		description = get_session_name() + ": Added ICE candidate!";
		return true;
	}
}

GstElement* UWebRTCSession::get_webrtcbin_element() {
	return m_webrtcbin;
}

bool UWebRTCSession::is_valid() {
	return m_is_valid;
}

ULogger& UWebRTCSession::get_logger() {
	return m_logger;
}

void UWebRTCSession::on_negotiation_needed(GstElement* webrtcbin, gpointer data) {
	auto session = static_cast<UWebRTCSession*>(data);
	if (!session) {
		std::cout << color::red << "[No Logger Error] [UCamera] Negotiation needed - nullptr with camera!\n" << color::reset;
		return;
	}
	if (!webrtcbin) {
		session->get_logger().error("Negotioation needed: Session" + session->get_session_name() + " not valid webrtcbin!");
		return;
	}
	session->get_logger().debug("Negotiation needed: Session " + session->get_session_name() + " - creating offer");

	auto promise = gst_promise_new_with_change_func(&UWebRTCSession::on_offer_created, session, nullptr);
	if (!promise) {
		session->m_logger.error("Negotiation needed: Session " + session->get_session_name() + " - nullptr with promise!");
		return;
	}

	g_signal_emit_by_name(webrtcbin, "create-offer", nullptr, promise);
}

void UWebRTCSession::on_offer_created(GstPromise* promise, gpointer data) {
	auto session = static_cast<UWebRTCSession*>(data);
	if (!session) {
		std::cout << color::red << "[UCamera] on_offer_created - nullptr camera\n" << color::reset;
		gst_promise_unref(promise);  // обязательно unref даже при ошибке
		return;
	}

	const GstStructure* reply = gst_promise_get_reply(promise);
	if (!reply) {
		session->get_logger().error(session->get_session_name() + ": on_offer_created - cannot get reply");
		gst_promise_unref(promise);
		return;
	}

	GstWebRTCSessionDescription* offer = nullptr;
	if (!gst_structure_get(reply, "offer", GST_TYPE_WEBRTC_SESSION_DESCRIPTION, &offer, nullptr) || !offer) {
		session->get_logger().error(session->get_session_name() + ": on_offer_created - cannot get offer from reply");
		gst_promise_unref(promise);
		return;
	}

	// Устанавливаем локальное описание (offer)
	g_signal_emit_by_name(session->get_webrtcbin_element(), "set-local-description", offer, nullptr);

	// Теперь можно unref промис, reply уже получен
	gst_promise_unref(promise);

	gchar* sdp_str = gst_sdp_message_as_text(offer->sdp);
	if (!sdp_str) {
		session->get_logger().error(session->get_session_name() + ": on_offer_created - cannot convert SDP to text");
		gst_webrtc_session_description_free(offer);
		return;
	}

	boost::json::object offer_msg = session->make_json(true, "offer", "Created sdp offer!");
	offer_msg[SIG_SDP] = std::string(sdp_str);

	g_free(sdp_str);

	std::string serialized_offer_msg = boost::json::serialize(offer_msg);
	session->send_message(serialized_offer_msg);

	session->get_logger().info(session->get_session_name() + ": created and sent sdp offer!\n\t" + serialized_offer_msg);

	gst_webrtc_session_description_free(offer);
}

void UWebRTCSession::send_message(const std::string& msg) {
	m_send_callback(msg);
}

void UWebRTCSession::on_ice_candidate(GstElement* webrtcbin, guint mlineindex, gchar* candidate, gpointer data) {
	auto session = static_cast<UWebRTCSession*>(data);

	boost::json::object ice_msg = session->make_json(true, "ice", "Sending Ice candidate");
	ice_msg[SIG_ICE_CANDIDATE] = std::string(candidate);
	ice_msg[SIG_ICE_LINE_INDEX] = static_cast<int>(mlineindex);

	std::string serialized_ice_message = boost::json::serialize(ice_msg);
	session->send_message(serialized_ice_message);
	session->get_logger().debug(session->get_session_name() + ": sended ICE candidate!");
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