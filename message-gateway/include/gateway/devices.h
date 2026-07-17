#pragma once

#include <boost/json.hpp>

namespace varan {
    namespace gateway {

        // Что сервис видит на машине: сетевые интерфейсы CAN и serial-порты.
        // Нужно странице, чтобы вместо ручного ввода "can0" был список того, что
        // реально есть, и было видно, поднят интерфейс или лежит.
        //
        // Перечисление всегда безопасно: устройств может не быть вовсе, и это не
        // ошибка — сервис обязан подниматься на машине без железа и ждать, пока
        // адаптер воткнут.
        //
        // Возвращает:
        // {
        //   "can":    [ { "name": "can0", "up": true, "kind": "can" } ],
        //   "serial": [ { "name": "/dev/ttyUSB0" } ]
        // }
        boost::json::object list_devices();

    } // namespace gateway
} // namespace varan
