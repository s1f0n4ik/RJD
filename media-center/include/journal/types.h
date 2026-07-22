#pragma once

#include <string>
#include <vector>
#include <array>
#include <optional>
#include <functional>
#include <filesystem>
#include <cstdint>

namespace varan {
namespace journal {

    // Один обнаруженный объект на кадре. Журнал config-агностичен: хранит только
    // числовой id класса и геометрию. Имя, цвет и суперкласс (опасность) — это
    // семантика конкретной нейроконфигурации; их резолвит тот, кто читает журнал
    // (фронт), по паре config_id + cid. Сам журнал о классах ничего не знает.
    struct FDetectionObject {
        int cid = 0;                      // id класса внутри своей конфигурации
        double cf = 0.0;                  // confidence 0..1
        std::array<int, 4> box{ 0, 0, 0, 0 }; // x, y, w, h в пикселях
        // Состояние трека на момент кадра: tentative / confirmed / lost.
        // Это домен журнала (не семантика конфигурации), поэтому храним как есть.
        std::string state;
    };

    // Одна запись журнала обнаружений: метаданные кадра + время + GPS +
    // камера/конфиг + объекты на кадре. Байтов изображения тут нет — кадр уже
    // записан слотом в файл, здесь только относительный путь. id строки
    // проставляет сама БД. config_id обязателен: без него id классов бессмысленны.
    struct FEntry {
        std::int64_t ts = 0;              // unix-время, мс
        std::string camera_id;
        std::string config_id;            // конфигурация, которой получены cid

        bool gps_valid = false;           // false — координаты не пишем
        double lat = 0.0;
        double lon = 0.0;
        double alt = 0.0;
        double speed = 0.0;               // м/с
        double course = 0.0;              // градусы

        int width = 0;
        int height = 0;
        // Путь к JPEG относительно корня кадров. Пусто — кадр потерян при
        // переполнении очереди: событие важнее картинки, поэтому строку пишем
        // всё равно, просто без изображения.
        std::string image_path;

        std::optional<std::int64_t> track_id; // трек-триггер (для дедупа), либо пусто
        std::string event;                // confirmed/lost/... либо пусто

        std::vector<FDetectionObject> objects;
    };

    // Приёмник записей журнала. Слот отдаёт готовую запись (кадр уже на диске),
    // writer пишет её в БД асинхронно.
    using FSink = std::function<void(FEntry)>;

    // Ручка журналирования для слота: куда писать файлы кадров и куда отдавать
    // метаданные. Пустой sink — журналирование выключено.
    struct FSlotJournal {
        std::filesystem::path frames_dir; // корень для JPEG (раскладка по дате)
        FSink sink;

        bool enabled() const { return static_cast<bool>(sink); }
    };

} // namespace journal
} // namespace varan
