#pragma once

#include <string>
#include <mutex>

#include <boost/json.hpp>

namespace varan {
    namespace gateway {

        // Простое файловое хранилище настроек: один JSON-файл на весь сервис.
        // Задача — пережить перезапуск контейнера, поэтому файл кладётся на том
        // (см. docker-compose). Формат верхнего уровня задаёт UGateway; хранилище
        // только читает и пишет объект целиком, атомарно (через временный файл и
        // rename), чтобы оборванная запись не оставила битый файл.
        class UStore {
        public:
            explicit UStore(std::string path);

            // Пустой путь — хранилище выключено: load отдаёт {}, save молчит. Так
            // сервис работает и без тома, просто без сохранения настроек.
            bool enabled() const { return !m_path.empty(); }

            // Весь файл как объект. Нет файла или битый — пустой объект без ошибки:
            // первый запуск не должен падать из-за отсутствия настроек.
            boost::json::object load() const;

            // Перезаписывает файл целиком. Ошибку только логирует: неудача записи
            // настроек не повод ронять живой сервис.
            void save(const boost::json::object& root) const;

        private:
            std::string m_path;
            mutable std::mutex m_mutex;
        };

    } // namespace gateway
} // namespace varan
