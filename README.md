# RJD
Регистратор + веб-сервис синхронизации

<img width="514" height="622" alt="image" src="https://github.com/user-attachments/assets/1c17fff1-78a0-40ba-9ddf-9c62f2ce3b4e" />



# ИНСТРУКЦИЯ РАЗВЕРТЫВАНИЯ
* Шаг 1: Подготовка Orange Pi 5B
 1. Обновление системы
sudo apt update && sudo apt upgrade -y

 2. Установка базовых пакетов
sudo apt install -y git curl wget nano

 3. Настройка сети (статический IP рекомендуется)
sudo nano /etc/netplan/01-netcfg.yaml

Шаг 2: Клонирование проекта
 Создание директории проекта
mkdir -p ~/video-recorder
cd ~/video-recorder

 Копирование всех файлов (код выше) в эту директорию
 Структура:

 <img width="205" height="315" alt="image" src="https://github.com/user-attachments/assets/6edcd21f-f707-4c6d-a27b-75375dbdef6b" />


Шаг 3: Конфигурация камер
 Редактирование конфигурации камер
nano config/cameras.yaml

 Замени IP-адреса, логины и пароли на реальные значения

Шаг 4: Тестирование камер
 Сделать скрипт исполняемым
chmod +x test_cameras.py

 Запустить тест
./test_cameras.py

 Ожидаемый вывод:
 
 === Orange Pi 5B Camera Test ===
 
 Found 3 cameras in configuration
 
 Testing Front Entrance (camera_01)...
 
 ✓ Connection successful
 
 ...

Шаг 5: Запуск бенчмарка (опционально)
chmod +x benchmark.py
./benchmark.py

Шаг 6: Развертывание
 Сделать скрипт исполняемым
chmod +x deploy.sh

 Запустить развертывание
sudo ./deploy.sh

# Скрипт выполнит:
 - Проверку платформы
 - Установку зависимостей
 - Настройку хранилища
 - Конфигурацию аппаратного ускорения
 - Сборку Docker образов
 - Запуск сервисов

Шаг 7: Проверка работы

 Проверка статуса контейнеров:
docker-compose ps

 Просмотр логов:
docker-compose logs -f video-recorder

 Проверка записи:
ls -lh /mnt/storage/recordings/

 Проверка NTP сервера:
curl http://localhost:8123/status

Шаг 8: Мониторинг системы

 Web Dashboard:
firefox http://<orange-pi-ip>:8080

 NTP API:
curl http://<orange-pi-ip>:8123/clients

 System stats:
docker stats



# ОПТИМИЗАЦИЯ И TROUBLESHOOTING
Оптимизация производительности
1. Настройка Rockchip MPP:
 Проверка поддержки аппаратного ускорения
ffmpeg -encoders | grep rkmpp

 Должны быть доступны:
 h264_rkmpp (Rockchip MPP H.264 encoder)
 hevc_rkmpp (Rockchip MPP H.265 encoder)

2. Настройка памяти:
* Увеличение CMA (Contiguous Memory Allocator)
sudo nano /boot/orangepiEnv.txt
* Добавить: extraargs=cma=512M

3. Настройка Docker:

 Ограничение ресурсов для контейнеров
 В docker-compose.yml:
 
resources:
  limits:
    cpus: '4'
    memory: 2G

# Решение проблем
1) Проблема: Камеры не подключаются

 Проверка сети:
ping <camera-ip>

 Проверка RTSP вручную: 
ffplay -rtsp_transport tcp rtsp://admin:password@<camera-ip>:554/stream1

 Проверка firewall:
sudo ufw status

2) Проблема: Высокая нагрузка на CPU

Проверка, что используется аппаратное ускорение:
docker-compose logs video-recorder | grep "h264_rkmpp"

 Если нет, проверь доступ к устройствам:
ls -l /dev/mpp_service /dev/dma_heap

3) Проблема: Заканчивается место на диске

 Проверка места:
df -h /mnt/storage/recordings

 Ручная очистка старых записей:
find /mnt/storage/recordings -type f -mtime +7 -delete

 Уменьшение retention_days в config/recording.yaml
