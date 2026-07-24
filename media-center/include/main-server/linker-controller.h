#pragma once

#include <boost/beast/http.hpp>
#include <memory>
#include <filesystem>

#include "bird-view/linker.h"

/*
	REST для Linker'a.

	GET    /linker/exports  → список stitching-конфигов (id, name, cameras keys)
	GET    /linker/state    → текущий save-файл (export_id, cameras, stream_id)
	POST   /linker/state    → перезаписать save-файл (Линкер сам зовёт reload_from_state)
	GET    /linker/status   → { running, export_id, stream_id, stream_name, fps }
	POST   /linker/start    → запустить, если не запущен
	POST   /linker/restart  → stop + reload + start
	POST   /linker/stop     → остановить
	DELETE /linker/export   → удалить конфигурацию целиком (запись, карты, настройки)

	GET    /linker/presets  → список пресетов конфигуратора (key, name, размер поля)
	GET    /linker/preset   → пресет целиком, для правки в конфигураторе
	GET    /linker/image    → картинка-подложка по имени файла
	POST   /linker/rotation → поворот вывода: 0, 90, 180, 270 против часовой.
	                          Живую конфигурацию пересобирает сразу
	POST   /linker/view-mode → режим вывода: top или surround.
	                           Живую конфигурацию пересобирает сразу
	GET    /linker/surround  → surround-блок с дефолтами + печёные позы камер
	POST   /linker/surround  → частичный мёрж surround-блока, живой вывод
	                           применяет без рестарта

	Пресеты и экспорты — разные файлы: первым владеет конфигуратор,
	второй собирает страница сборки.
*/
class ULinkerController {
public:
	ULinkerController(std::shared_ptr<varan::birdview::ULinker> linker, ULogger* logger = nullptr);

	boost::beast::http::response<boost::beast::http::string_body>
		get_exports(const boost::beast::http::request<boost::beast::http::string_body>& req);

	boost::beast::http::response<boost::beast::http::string_body>
		get_export(const boost::beast::http::request<boost::beast::http::string_body>& req);

	boost::beast::http::response<boost::beast::http::string_body>
		get_state(const boost::beast::http::request<boost::beast::http::string_body>& req);

	boost::beast::http::response<boost::beast::http::string_body>
		post_state(const boost::beast::http::request<boost::beast::http::string_body>& req);

	boost::beast::http::response<boost::beast::http::string_body>
		get_status(const boost::beast::http::request<boost::beast::http::string_body>& req);

	boost::beast::http::response<boost::beast::http::string_body>
		post_start(const boost::beast::http::request<boost::beast::http::string_body>& req);

	boost::beast::http::response<boost::beast::http::string_body>
		post_restart(const boost::beast::http::request<boost::beast::http::string_body>& req);

	boost::beast::http::response<boost::beast::http::string_body>
		post_stop(const boost::beast::http::request<boost::beast::http::string_body>& req);

	boost::beast::http::response<boost::beast::http::string_body>
		delete_export(const boost::beast::http::request<boost::beast::http::string_body>& req);

	boost::beast::http::response<boost::beast::http::string_body>
		post_rotation(const boost::beast::http::request<boost::beast::http::string_body>& req);

	boost::beast::http::response<boost::beast::http::string_body>
		post_view_mode(const boost::beast::http::request<boost::beast::http::string_body>& req);

	boost::beast::http::response<boost::beast::http::string_body>
		post_surround_camera(const boost::beast::http::request<boost::beast::http::string_body>& req);

	boost::beast::http::response<boost::beast::http::string_body>
		post_surround(const boost::beast::http::request<boost::beast::http::string_body>& req);

	boost::beast::http::response<boost::beast::http::string_body>
		get_surround(const boost::beast::http::request<boost::beast::http::string_body>& req);

	boost::beast::http::response<boost::beast::http::string_body>
		get_presets(const boost::beast::http::request<boost::beast::http::string_body>& req);

	boost::beast::http::response<boost::beast::http::string_body>
		get_preset(const boost::beast::http::request<boost::beast::http::string_body>& req);

	boost::beast::http::response<boost::beast::http::string_body>
		post_exports(const boost::beast::http::request<boost::beast::http::string_body>& req);

	boost::beast::http::response<boost::beast::http::string_body>
		post_upload_image(const boost::beast::http::request<boost::beast::http::string_body>& req);

	boost::beast::http::response<boost::beast::http::string_body>
		get_image(const boost::beast::http::request<boost::beast::http::string_body>& req);


private:
	std::shared_ptr<varan::birdview::ULinker> m_linker;
	ULogger* m_logger;
};