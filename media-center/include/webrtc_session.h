#pragma once

#include <string>
#include <functional>

#include <gst/gst.h>
#include <boost/json.hpp>

#include "logger.h"

class UWebRTCSession {

	using CSendMessage = std::function<void(const std::string& msg)>;

public:
	UWebRTCSession(std::string client, std::string camera, bool is_sub, GstElement* pipeline, GstElement* tee, CSendMessage send_callback, ULogger& logger);

	~UWebRTCSession();

	UWebRTCSession(const UWebRTCSession&) = delete;
	UWebRTCSession& operator=(const UWebRTCSession&) = delete;

	void teardown();

	bool create_branch(const std::string& codec);

	void make_offer(const boost::json::object& message);

	void create_answer(const boost::json::object& message);

	void add_ice_candidate(const boost::json::object& message);

	boost::json::object make_json(bool successed, const std::string& type, const std::string& description);

	// Геттеры и сеттеры
	void send_message(const std::string& msg);

	GstElement* get_webrtcbin_element();

	bool is_valid();

	std::string get_session_name();

	ULogger& get_logger();

private:
	std::string m_client_id;
	std::string m_camera_name;

	GstElement* m_pipeline;
	GstElement* m_tee;

	GstPad* m_tee_pad_src;

	GstElement* m_queue;
	GstElement* m_pay;
	GstElement* m_webrtcbin;

	CSendMessage m_send_callback;

	ULogger& m_logger;

	bool m_is_valid;
	bool m_is_sub;

	static void on_negotiation_needed(GstElement* webrtcbin, gpointer data);

	static void on_offer_created(GstPromise* promise, gpointer data);

	static void on_ice_candidate(GstElement* webrtcbin, guint mlineindex, gchar* candidate, gpointer data);
};