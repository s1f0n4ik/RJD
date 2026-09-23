#include "neural/input-editor.h"

#include "signaling_definers.h"

namespace varan {
namespace neural {

	namespace {
		// Маршрут у брокера: пара «модуль один клиент», как у калибратора
		const std::string EDITOR_URL = "/calibrator/neural-editor";
		const std::string EDITOR_STREAM_ID = "neural_editor";
		const std::string TYPE_OPEN = "open";
		const std::string TYPE_UPDATE = "update";
		const std::string TYPE_CLOSE = "close";
		const std::string TYPE_PING = "ping";
		const std::string TYPE_STATUS = "status";
		const std::string TYPE_TILES = "tiles";
		const std::string TYPE_MESSAGE = "message";
		// Без сообщений от клиента дольше этого сессия гасится
		constexpr auto IDLE_TIMEOUT = std::chrono::seconds(30);
		constexpr int DEFAULT_FPS = 10;

		boost::json::array rect_json(const cv::Rect& r) {
			boost::json::array a;
			a.emplace_back(r.x);
			a.emplace_back(r.y);
			a.emplace_back(r.width);
			a.emplace_back(r.height);
			return a;
		}
	}

	UInputEditor::UInputEditor(
		const std::string& ip_address,
		const std::string& port,
		birdview::UEGLContextManager* context,
		FFrameStorage<IFrame>* storage,
		std::shared_ptr<UNeuralLoader> loader,
		ULogger::ELoggerLevel level)
		: UWebSocketHandler(ip_address, port, level, "InputEditor")
		, m_context(context)
		, m_storage(storage)
		, m_loader(std::move(loader))
		, m_level(level)
	{
	}

	UInputEditor::~UInputEditor() {
		stop_websocket_connection();
	}

	void UInputEditor::start_websocket_connection() {
		start_websocket_client(EDITOR_URL, m_name);
		if (!m_watchdog_running.exchange(true))
			m_watchdog = std::thread(&UInputEditor::watchdog_loop, this);
	}

	void UInputEditor::stop_websocket_connection() {
		if (m_watchdog_running.exchange(false)) {
			m_watchdog_cv.notify_all();
			if (m_watchdog.joinable()) m_watchdog.join();
		}
		{
			std::lock_guard<std::mutex> lk(m_session_mutex);
			close_session();
		}
		stop_websocket_client();
	}

	void UInputEditor::touch() {
		m_last_activity.store(std::chrono::steady_clock::now().time_since_epoch().count());
	}

	void UInputEditor::on_signaling_message(const std::string& msg) {
		auto on_error = [&](const std::string& type, const std::string& err, const std::string* client_id) {
			send_message(make_socket_error(type, err, client_id, &m_name));
			m_logger.error(type + ": " + err);
		};

		try {
			boost::json::value parsed = boost::json::parse(msg);
			if (!parsed.is_object()) {
				on_error(TYPE_MESSAGE, "message is not an object", nullptr);
				return;
			}
			const auto& o = parsed.as_object();

			std::string client_id;
			if (auto* v = o.if_contains("client_id"); v && v->is_string()) client_id = v->as_string().c_str();
			else { on_error(TYPE_MESSAGE, "missing client_id", nullptr); return; }

			std::string type;
			if (auto* v = o.if_contains("type"); v && v->is_string()) type = v->as_string().c_str();
			else { on_error(TYPE_MESSAGE, "missing type", &client_id); return; }

			static const boost::json::object empty_meta;
			const boost::json::object* meta = &empty_meta;
			if (auto* v = o.if_contains("meta"); v && v->is_object()) meta = &v->as_object();

			touch();

			if (type == TYPE_OPEN) handle_open(client_id, *meta, on_error);
			else if (type == TYPE_UPDATE) handle_update(client_id, *meta, on_error);
			else if (type == TYPE_CLOSE) {
				std::string reason;
				if (auto* v = meta->if_contains("description"); v && v->is_string()) reason = v->as_string().c_str();
				handle_close(client_id, reason);
			}
			else if (type == TYPE_PING) {
				boost::json::object reply;
				reply["open"] = !m_client_id.empty();
				send_message(make_socket_message(type, true, &client_id, &m_name, &reply));
			}
			else if (type == TYPE_STATUS) handle_status(client_id);
			else on_error(type, "unknown type", &client_id);
		}
		catch (const std::exception& e) {
			on_error(TYPE_MESSAGE, std::string("exception: ") + e.what(), nullptr);
		}
	}

	void UInputEditor::handle_open(const std::string& client_id, const boost::json::object& meta, const FErrorSink& on_error) {
		FVideoStream stream;
		std::string stream_id;
		if (auto* v = meta.if_contains("stream_id"); v && v->is_string()) stream_id = v->as_string().c_str();

		if (auto* v = meta.if_contains("stream"); v && v->is_object()) {
			stream = parse_stream(*v, stream_id);
		}
		else if (!stream_id.empty()) {
			auto saved = m_loader->get_stream(stream_id);
			if (!saved) { on_error(TYPE_OPEN, "stream '" + stream_id + "' not found", &client_id); return; }
			stream = *saved;
		}
		if (stream.id.empty()) stream.id = "editor";
		if (auto* v = meta.if_contains("config_id"); v && v->is_string() && !v->as_string().empty())
			stream.config_id = v->as_string().c_str();

		int fps = DEFAULT_FPS;
		if (auto* v = meta.if_contains("fps"); v && v->is_int64()) fps = std::clamp<int>((int)v->as_int64(), 1, 30);

		// Размер полотна — вход модели конфигурации; без модели остаётся сохранённый в потоке
		int width = stream.width;
		int height = stream.height;
		std::string size_source = "stream";
		if (!stream.config_id.empty() && m_loader->probe_model_size(stream.config_id, width, height))
			size_source = "model";
		stream.width = width;
		stream.height = height;

		std::string err;
		if (!is_valid_stream(stream, &err, true)) { on_error(TYPE_OPEN, err, &client_id); return; }

		std::lock_guard<std::mutex> lk(m_session_mutex);
		if (!m_client_id.empty() && m_client_id != client_id) {
			on_error(TYPE_OPEN, "editor is busy by client " + m_client_id, &client_id);
			return;
		}
		close_session();
		if (!open_session(stream, width, height, fps, err)) {
			close_session();
			on_error(TYPE_OPEN, err, &client_id);
			return;
		}
		m_client_id = client_id;

		auto reply = session_meta();
		reply["size_source"] = size_source;
		send_message(make_socket_message(TYPE_OPEN, true, &client_id, &m_name, &reply));
		m_logger.info("open: client=" + client_id + " stream=" + stream.id + " canvas=" +
			std::to_string(width) + "x" + std::to_string(height) + " fps=" + std::to_string(fps));
	}

	void UInputEditor::handle_update(const std::string& client_id, const boost::json::object& meta, const FErrorSink& on_error) {
		std::lock_guard<std::mutex> lk(m_session_mutex);
		if (m_client_id.empty() || !m_composer) { on_error(TYPE_UPDATE, "editor is not open", &client_id); return; }
		if (m_client_id != client_id) { on_error(TYPE_UPDATE, "editor is busy by client " + m_client_id, &client_id); return; }

		auto* v = meta.if_contains("stream");
		if (!v || !v->is_object()) { on_error(TYPE_UPDATE, "missing stream object", &client_id); return; }

		FVideoStream stream = parse_stream(*v, m_stream.id);
		if (stream.config_id.empty()) stream.config_id = m_stream.config_id;
		if (stream.name.empty()) stream.name = m_stream.name;
		// Размер полотна задан при open и меняется только новым open
		stream.width = m_width;
		stream.height = m_height;

		std::string err;
		if (!is_valid_stream(stream, &err, true)) { on_error(TYPE_UPDATE, err, &client_id); return; }

		m_stream = stream;
		m_composer->set_stream(stream);

		auto reply = session_meta();
		send_message(make_socket_message(TYPE_UPDATE, true, &client_id, &m_name, &reply));
	}

	void UInputEditor::handle_close(const std::string& client_id, const std::string& reason) {
		std::lock_guard<std::mutex> lk(m_session_mutex);
		if (m_client_id.empty()) {
			send_message(make_socket_message(TYPE_CLOSE, true, &client_id, &m_name));
			return;
		}
		m_logger.info("close: client=" + client_id + (reason.empty() ? "" : " (" + reason + ")"));
		close_session();
		send_message(make_socket_message(TYPE_CLOSE, true, &client_id, &m_name));
	}

	void UInputEditor::handle_status(const std::string& client_id) {
		std::lock_guard<std::mutex> lk(m_session_mutex);
		boost::json::object reply;
		reply["open"] = !m_client_id.empty();
		reply["client_id"] = m_client_id;
		if (!m_client_id.empty()) {
			for (auto& [k, val] : session_meta()) reply[k] = val;
		}
		send_message(make_socket_message(TYPE_STATUS, true, &client_id, &m_name, &reply));
	}

	bool UInputEditor::open_session(const FVideoStream& stream, int width, int height, int fps, std::string& err) {
		try {
			m_streamer = std::make_unique<UVirtualCamera>(
				EDITOR_STREAM_ID, FWebSocketOptions{ m_ip_adress, m_port }, m_level);
			if (!m_streamer->set_parameters(width, height, fps)) throw std::runtime_error("set_parameters failed");
			if (!m_streamer->initialize()) throw std::runtime_error("initialize failed");
			if (!m_streamer->start()) throw std::runtime_error("start failed");
			m_streamer->update_metadata("Редактор видеопотока", "");
		}
		catch (const std::exception& e) {
			err = std::string("editor output: ") + e.what();
			return false;
		}

		m_composer = std::make_unique<UCanvasComposer>(
			m_context, m_storage, width, height, stream,
			[this](cv::Mat rgba, FCanvasInfo) {
				// Сборщик останавливается раньше, чем исчезает вывод (см. close_session)
				if (m_streamer) m_streamer->push_frame(std::move(rgba));
			},
			m_level, "Canvas<editor>");
		if (!m_composer->start(fps)) {
			err = "canvas composer didn't start";
			return false;
		}

		m_stream = stream;
		m_width = width;
		m_height = height;
		return true;
	}

	void UInputEditor::close_session() {
		if (m_composer) {
			m_composer->stop();
			m_composer.reset();
		}
		if (m_streamer) {
			try { m_streamer->stop(); }
			catch (...) {}
			m_streamer.reset();
		}
		m_client_id.clear();
		m_width = 0;
		m_height = 0;
	}

	boost::json::object UInputEditor::session_meta() const {
		boost::json::object o;
		o["id_stream"] = EDITOR_STREAM_ID;
		o["width"] = m_width;
		o["height"] = m_height;
		o["stream"] = serialize_stream(m_stream);
		o["tiles"] = tiles_json();
		return o;
	}

	boost::json::array UInputEditor::tiles_json() const {
		boost::json::array arr;
		// До первого тика — ячейки без состояния
		std::vector<FTilePlacement> cells;
		FCanvasInfo info = m_composer ? m_composer->tiles() : FCanvasInfo{};
		const auto& tiles = info ? *info : (cells = place_cells(m_stream));
		for (const auto& t : tiles) {
			boost::json::object to;
			to["camera"] = t.camera;
			to["state"] = tile_state_str(t.state);
			to["cell"] = rect_json(t.cell);
			to["rect"] = rect_json(t.dst);
			to["camera_width"] = t.cam_w;
			to["camera_height"] = t.cam_h;
			arr.push_back(std::move(to));
		}
		return arr;
	}

	void UInputEditor::watchdog_loop() {
		using clock = std::chrono::steady_clock;
		while (m_watchdog_running.load()) {
			{
				std::unique_lock<std::mutex> lk(m_watchdog_mutex);
				m_watchdog_cv.wait_for(lk, std::chrono::seconds(1), [this] { return !m_watchdog_running.load(); });
			}
			if (!m_watchdog_running.load()) break;

			std::lock_guard<std::mutex> lk(m_session_mutex);
			if (m_client_id.empty()) continue;

			const auto last = clock::time_point(clock::duration(m_last_activity.load()));
			if (clock::now() - last > IDLE_TIMEOUT) {
				m_logger.warn("watchdog: client " + m_client_id + " is silent, closing session");
				const std::string client = m_client_id;
				close_session();
				boost::json::object meta;
				meta["description"] = "idle timeout";
				send_message(make_socket_message(TYPE_CLOSE, true, &client, &m_name, &meta));
				continue;
			}

			boost::json::object meta;
			meta["tiles"] = tiles_json();
			send_message(make_socket_message(TYPE_TILES, true, &m_client_id, &m_name, &meta));
		}
	}

} // namespace neural
} // namespace varan
