# Удаленная разработка media-center на Orange Pi

Код правится локально на Windows, а сборка/запуск идут на устройстве arm64-Linux
(Orange Pi) по SSH. IntelliSense в VSCode настроен на заголовки устройства.

## Разовая настройка

1. SSH-доступ по ключу к устройству (алиас `orangepi-mc` в `~/.ssh/config`,
   HostName `192.168.1.102`, ключ `~/.ssh/id_ed25519_orangepi_mc`).
   Проверка: `ssh orangepi-mc echo ok` должно пройти без пароля.
2. Первая заливка с зависимостями и сборка:
   ```
   bash scripts/deploy.sh --deps
   ```
3. Генерация IntelliSense (зеркалит системные заголовки устройства, ~150MB):
   ```
   bash scripts/gen-intellisense.sh --headers
   ```
   В VSCode: `C/C++: Reset IntelliSense Database`.

Параметры устройства меняются в `scripts/lib.sh` (или через переменные
`MC_REMOTE`, `MC_REMOTE_DIR`, `MC_GST_ENV`, `MC_BUILD_TYPE`).

## Ежедневный цикл

Всё доступно через палитру задач VSCode (`Ctrl+Shift+P` → `Run Task`) или из терминала:

| Задача VSCode                          | Скрипт                          | Что делает |
|----------------------------------------|---------------------------------|------------|
| media-center: Deploy (sync + build)    | `deploy.sh`                     | заливка кода + сборка (по умолчанию `Ctrl+Shift+B`) |
| media-center: Sync                     | `sync.sh`                       | быстрая заливка только кода (~2с) |
| media-center: Sync (+ 3rdparty)        | `sync.sh --deps`                | заливка кода и зависимостей |
| media-center: Build (Release/Debug)    | `build.sh [Release\|Debug]`     | сборка без заливки |
| media-center: Clean build              | `build.sh --clean`              | полная пересборка |
| media-center: Run                      | `run.sh`                        | запуск бинарника на устройстве |
| media-center: Deploy + Run             | `deploy.sh --run`               | заливка + сборка + запуск |
| media-center: Update IntelliSense      | `gen-intellisense.sh`           | обновить `compile_commands.json` после изменения зависимостей/флагов |
| media-center: Update IntelliSense (+ headers) | `gen-intellisense.sh --headers` | + перезеркалировать системные заголовки устройства |

## Как устроен IntelliSense

- Сборка на устройстве экспортирует `compile_commands.json`.
- `gen-intellisense.sh` забирает его, зеркалит нужные системные заголовки
  устройства в `.intellisense-sysroot/` и переписывает пути на локальные.
- Генерируется `.vscode/c_cpp_properties.json` (`intelliSenseMode: linux-gcc-arm64`),
  где `compile_commands.json` даёт пути проекта/GStreamer/OpenCV, а `includePath`
  добавляет стандартную библиотеку C++ из зеркала.

`compile_commands.json`, `.intellisense-sysroot/` и `.vscode/c_cpp_properties.json`
машинно-генерируемые и добавлены в `.gitignore`.
