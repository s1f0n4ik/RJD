# Примеры API запросов к камерам

## 1. Получение всех камер

**Запрос:**  
```
GET http://192.168.1.2:7777/camera
```

**Результат:**
```json
{
    "data": {
        "cameras": {
            "camera_4": {
                "description": "Test camera",
                "ip_adress": "192.168.1.14",
                "port": "554",
                "streams": {
                    "main": {
                        "codec": "H265",
                        "fps": 25,
                        "height": 1440,
                        "latency": 0,
                        "reconnect": 10,
                        "record_path": "/home/orangepi/records/camera_04",
                        "rtsp": "rtsp://admin:VniiTest@192.168.1.14:554/cam/realmonitor?channel=1&subtype=0",
                        "segment": 10,
                        "status": 5,
                        "type": 1,
                        "use_udp": false,
                        "width": 2560
                    },
                    "sub": {
                        "codec": "H265",
                        "fps": 25,
                        "height": 576,
                        "latency": 0,
                        "reconnect": 10,
                        "record_path": "",
                        "rtsp": "rtsp://admin:VniiTest@192.168.1.14:554/cam/realmonitor?channel=1&subtype=1",
                        "segment": -1,
                        "status": 5,
                        "type": 2,
                        "use_udp": false,
                        "width": 704
                    }
                },
                "user": "admin"
            },
            "camera_3": { ... },
            "camera_2": { ... },
            "camera_1": { ... }
        }
    },
    "meta": null,
    "error": null
}
```

---

## 2. Получение конкретной камеры по имени

**Запрос:**  
```
GET http://192.168.1.2:7777/camera?name=camera_1
```

**Результат:**
```json
{
    "data": {
        "cameras": {
            "camera_1": {
                "description": "Test camera",
                "ip_adress": "",
                "port": "",
                "streams": {
                    "main": {
                        "codec": "H265",
                        "fps": 25,
                        "height": 1368,
                        "latency": 0,
                        "reconnect": 10,
                        "record_path": "/home/orangepi/records/camera_01",
                        "rtsp": "rtsp://admin:VniiTest@192.168.1.11:554/ISAPI/Streaming/Channels/101",
                        "segment": 10,
                        "status": 3,
                        "type": 1,
                        "use_udp": false,
                        "width": 3040
                    },
                    "sub": {
                        "codec": "H264",
                        "fps": 25,
                        "height": 536,
                        "latency": 0,
                        "reconnect": 10,
                        "record_path": "",
                        "rtsp": "rtsp://admin:VniiTest@192.168.1.11:554/ISAPI/Streaming/Channels/102",
                        "segment": -1,
                        "status": 3,
                        "type": 2,
                        "use_udp": false,
                        "width": 1200
                    }
                },
                "user": ""
            }
        }
    },
    "meta": null,
    "error": null
}
```

---

## 3. Получение конкретных полей камер

**Запрос:**  
```
GET http://192.168.1.2:7777/camera?fields=ip_adress,streams.codec
```

**Результат:**
```json
{
    "data": {
        "cameras": {
            "camera_4": {
                "ip_adress": "192.168.1.14",
                "streams": {
                    "main": { "codec": "H265" },
                    "sub": { "codec": "H265" }
                }
            },
            "camera_3": { ... },
            "camera_2": { ... },
            "camera_1": { ... }
        }
    },
    "meta": null,
    "error": null
}
```

---

## 4. Добавление новой камеры

**Запрос:**  
```
POST http://192.168.1.2:7777/camera
```

**Тело запроса (JSON):**
```json
{
    "name": "camera_6",
    "description": "Test Camera",
    "ip_adress": "192.168.1.16",
    "port": "554",
    "user": "admin",
    "password": "VniiTest",
    "production": 2,
    "type": 1,
    "streams": {
        "main pipeline": {
            "type": 1,
            "sub": 1,
            "latency": 0,
            "use_udp": false,
            "reconnect": 10,
            "record_path": "/home/orangepi/records/camera_06",
            "segment": 10
        },
        "sub pipeline": {
            "type": 2,
            "sub": 2,
            "latency": 0,
            "use_udp": false,
            "reconnect": 10,
            "record_path": "",
            "segment": 0
        }
    }
}
```

**Ответ:**
```json
{
    "data": {
        "result": "success",
        "details": "Camera camera_6 successfully added to nvr!"
    },
    "meta": null,
    "error": null
}
```

---

## 5. Удаление камеры

**Запрос:**  
```
DELETE http://192.168.1.2:7777/camera?name=camera_6
```

**Успешный ответ:**
```json
{
    "data": {
        "result": "success",
        "details": "Camera with name camera_6 successfully pended to delete!"
    },
    "meta": null,
    "error": null
}
```

**Ошибка (если камеры нет):**
```json
{
    "data": null,
    "meta": null,
    "error": {
        "code": 402,
        "message": "Bad Request",
        "details": "Camera with name camera_6 doesn't exist in nvr!"
    }
}
```

# POST-запросы для добавления камер

Все запросы отправляются на эндпоинт:

```
POST http://192.168.1.2:7778/camera
```

Тело запроса в формате JSON содержит данные о камере.

---

## Камера 6

```json
{
    "name": "camera_6",
    "description": "Test Camera",
    "ip_adress": "192.168.1.16",
    "port": "554",
    "user": "admin",
    "password": "VniiTest",
    "production": 2,
    "type": 3,
    "streams": {
        "main": {
            "sub": 1,
            "type": 1,
            "latency": 0,
            "use_udp": false,
            "reconnect": 10,
            "record_path": "/home/orangepi/records/camera_06",
            "segment": 10
        },
        "sub": {
            "sub": 2,
            "type": 2,
            "latency": 0,
            "use_udp": false,
            "reconnect": 10,
            "record_path": "",
            "segment": 0
        }
    }
}
```

---

## Камера 7

```json
{
    "name": "camera_7",
    "description": "Test Camera",
    "ip_adress": "192.168.1.17",
    "port": "554",
    "user": "admin",
    "password": "VniiTest",
    "production": 1,
    "type": 3,
    "streams": {
        "main": {
            "sub": 0,
            "type": 1,
            "latency": 0,
            "use_udp": false,
            "reconnect": 10,
            "record_path": "/home/orangepi/records/camera_07",
            "segment": 10
        },
        "sub": {
            "sub": 1,
            "type": 2,
            "latency": 0,
            "use_udp": false,
            "reconnect": 10,
            "record_path": "",
            "segment": 0
        }
    }
}
```

---

## Камера 8

```json
{
    "name": "camera_8",
    "description": "Test Camera",
    "ip_adress": "192.168.1.18",
    "port": "554",
    "user": "admin",
    "password": "VniiTest",
    "production": 1,
    "type": 3,
    "streams": {
        "main": {
            "sub": 0,
            "type": 1,
            "latency": 0,
            "use_udp": false,
            "reconnect": 10,
            "record_path": "/home/orangepi/records/camera_08",
            "segment": 10
        },
        "sub": {
            "sub": 1,
            "type": 2,
            "latency": 0,
            "use_udp": false,
            "reconnect": 10,
            "record_path": "",
            "segment": 0
        }
    }
}
```

---

## Камера 9

```json
{
    "name": "camera_9",
    "description": "Test Camera",
    "ip_adress": "192.168.1.19",
    "port": "554",
    "user": "admin",
    "password": "VniiTest",
    "production": 2,
    "type": 3,
    "streams": {
        "main": {
            "sub": 1,
            "type": 1,
            "latency": 0,
            "use_udp": false,
            "reconnect": 10,
            "record_path": "/home/orangepi/records/camera_09",
            "segment": 10
        },
        "sub": {
            "sub": 2,
            "type": 2,
            "latency": 0,
            "use_udp": false,
            "reconnect": 10,
            "record_path": "",
            "segment": 0
        }
    }
}
```

---

## Камера 10

```json
{
    "name": "camera_10",
    "description": "Test Camera",
    "ip_adress": "192.168.1.31",
    "port": "554",
    "user": "admin",
    "password": "VniiTest",
    "production": 3,
    "type": 3,
    "streams": {
        "main": {
            "sub": 0,
            "type": 1,
            "latency": 0,
            "use_udp": false,
            "reconnect": 10,
            "record_path": "/home/orangepi/records/camera_10",
            "segment": 10
        },
        "sub": {
            "sub": 1,
            "type": 2,
            "latency": 0,
            "use_udp": false,
            "reconnect": 10,
            "record_path": "",
            "segment": 0
        }
    }
}
```

---

## Камера 11

```json
{
    "name": "camera_11",
    "description": "Test Camera",
    "ip_adress": "192.168.1.32",
    "port": "554",
    "user": "admin",
    "password": "VniiTest",
    "production": 3,
    "type": 3,
    "streams": {
        "main": {
            "sub": 0,
            "type": 1,
            "latency": 0,
            "use_udp": false,
            "reconnect": 10,
            "record_path": "/home/orangepi/records/camera_11",
            "segment": 10
        },
        "sub": {
            "sub": 1,
            "type": 2,
            "latency": 0,
            "use_udp": false,
            "reconnect": 10,
            "record_path": "",
            "segment": 0
        }
    }
}
```

