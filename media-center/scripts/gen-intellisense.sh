#!/usr/bin/env bash
# Настройка IntelliSense для локальной разработки под arm64-Linux цель.
#
# Что делает:
#   1. Забирает compile_commands.json со сборки на устройстве.
#   2. Определяет все системные каталоги заголовков (из compile_commands +
#      неявные пути gcc) и зеркалит их в .intellisense-sysroot/.
#   3. Переписывает пути в compile_commands.json на локальные (проект + sysroot).
#   4. Генерирует .vscode/c_cpp_properties.json, чтобы расширение C/C++ в VSCode
#      находило все заголовки офлайн (включая стандартную библиотеку C++).
#
# Требует, чтобы сборка (build.sh) уже была выполнена.
#
# Использование:
#   gen-intellisense.sh            обновить compile_commands (быстро)
#   gen-intellisense.sh --headers  + перезеркалить системные заголовки (долго)

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

MIRROR_HEADERS=false
[[ "${1:-}" == "--headers" ]] && MIRROR_HEADERS=true

WORKSPACE_DIR="$(cd "$PROJECT_DIR/.." && pwd)"
VSCODE_DIR="$WORKSPACE_DIR/.vscode"

# Локальные пути в форме, понятной расширению C/C++ на Windows (forward slashes)
PROJ_LOCAL="$(cd "$PROJECT_DIR" && pwd -W 2>/dev/null || pwd)"
SYSROOT_LOCAL="${PROJ_LOCAL}/.intellisense-sysroot"

log "Получение compile_commands.json со сборки"
TMP="$(mktemp)"
scp -q "$REMOTE:$REMOTE_DIR/build/compile_commands.json" "$TMP"

# Неявные системные каталоги gcc (стандартная библиотека C++, встроенные заголовки)
log "Определение неявных путей gcc на устройстве"
mapfile -t GCC_DIRS < <(ssh "$REMOTE" "source '$GST_ENV' 2>/dev/null; echo | g++ -xc++ -E -v - 2>&1 | sed -n '/#include <...> search starts/,/End of search list/p' | grep '^ ' | sed 's/^ *//'")

# Предопределенные макросы компилятора устройства.
# Нужны, потому что compilerPath пустой (arm64-компилятор на Windows не запустить),
# и cpptools иначе откатывается на макросы MSVC. Берем только объектные макросы
# (функциональные вида NAME(...) cpptools в defines не поддерживает).
log "Определение предопределенных макросов компилятора устройства"
mapfile -t GCC_DEFINES < <(ssh "$REMOTE" "source '$GST_ENV' 2>/dev/null; echo | g++ -std=c++20 -dM -E -x c++ -" 2>/dev/null \
    | awk '
        /^#define [A-Za-z_][A-Za-z0-9_]*\(/ { next }
        /^#define / {
            name=$2
            rest=substr($0, index($0,$2)+length($2))
            sub(/^[ \t]+/,"",rest)
            if (rest=="") print name; else print name "=" rest
        }')

if $MIRROR_HEADERS || [ ! -d "$SYSROOT_DIR/usr/include" ]; then
    # Явные системные include из compile_commands (кроме каталогов проекта)
    mapfile -t EXPLICIT_DIRS < <(grep -oE '(-I ?|-isystem ?)/[^ "]+' "$TMP" \
        | sed -E 's/^(-I ?|-isystem ?)//' \
        | grep -v "^$REMOTE_DIR" \
        | sort -u)

    ALL_DIRS=("${EXPLICIT_DIRS[@]}" "${GCC_DIRS[@]}")
    # Уникальные существующие каталоги
    mapfile -t MIRROR_DIRS < <(printf '%s\n' "${ALL_DIRS[@]}" | sort -u)

    log "Зеркалирование системных заголовков устройства -> .intellisense-sysroot (долго)"
    mkdir -p "$SYSROOT_DIR"
    # -h на устройстве разыменовывает симлинки (Windows-tar не создает симлинки)
    ssh "$REMOTE" "tar czhf - ${MIRROR_DIRS[*]} 2>/dev/null" | tar xzf - -C "$SYSROOT_DIR" 2>/dev/null || true
    log "Заголовки зеркалированы (${#MIRROR_DIRS[@]} каталогов)"
else
    log "Заголовки уже зеркалированы (--headers для обновления)"
fi

# Неявные системные каталоги gcc как явные -isystem флаги.
# cpptools для файлов из compile_commands использует ТОЛЬКО флаги команды
# (includePath из c_cpp_properties игнорируется), а стандартные заголовки
# (/usr/include, c++/11 и т.д.) компилятор подключает неявно и в команде их нет.
# Поэтому вписываем их прямо в каждую команду, указывая на локальное зеркало.
ISYSTEM=""
for d in "${GCC_DIRS[@]}"; do
    ISYSTEM+="-isystem ${SYSROOT_LOCAL}${d} "
done

log "Переписывание путей: $REMOTE_DIR -> $PROJ_LOCAL"
# 1) пути проекта (удаленный корень -> локальный корень)
# 2) оставшиеся абсолютные системные include -> локальное зеркало sysroot
# 3) вставка неявных системных -isystem сразу после компилятора в каждой команде
sed \
    -e "s#${REMOTE_DIR}#${PROJ_LOCAL}#g" \
    -e "s#-I/#-I${SYSROOT_LOCAL}/#g" \
    -e "s#-isystem /#-isystem ${SYSROOT_LOCAL}/#g" \
    -e "s#-isystem/#-isystem${SYSROOT_LOCAL}/#g" \
    -e "s#\(\"command\": \"[^ ]* \)#\1${ISYSTEM}#" \
    "$TMP" > "$PROJECT_DIR/compile_commands.json"
rm -f "$TMP"

# Генерация c_cpp_properties.json: compile_commands дает пути проекта/GStreamer/OpenCV,
# includePath добавляет неявные пути gcc (stdlib), которых нет в compile_commands.
log "Генерация .vscode/c_cpp_properties.json"
mkdir -p "$VSCODE_DIR"

# includePath собираем из готового compile_commands.json: там уже все каталоги
# проекта и зависимостей (GStreamer, OpenCV, glib и т.д.) как локальные пути,
# плюс неявные пути gcc из зеркала. Это полный самодостаточный набор —
# compileCommands в конфиг не включаем, чтобы cpptools не подставлял MSVC.
mapfile -t PATHS < <(
    {
        grep -oE '(-I|-isystem )[^ "]+' "$PROJECT_DIR/compile_commands.json" \
            | sed -E 's/^-I//; s/^-isystem //'
        for d in "${GCC_DIRS[@]}"; do echo "${SYSROOT_LOCAL}${d}"; done
    } | sort -u
)

INCLUDE_LINES=""
for i in "${!PATHS[@]}"; do
    sep=","
    [[ $i -eq $((${#PATHS[@]} - 1)) ]] && sep=""
    INCLUDE_LINES+="                \"${PATHS[$i]}\"${sep}"$'\n'
done

# Массив defines: макросы компилятора устройства, с JSON-экранированием значений.
DEFINE_LINES=""
for i in "${!GCC_DEFINES[@]}"; do
    e="${GCC_DEFINES[$i]}"
    e="${e//\\/\\\\}"   # экранируем обратный слэш
    e="${e//\"/\\\"}"   # экранируем кавычку
    sep=","
    [[ $i -eq $((${#GCC_DEFINES[@]} - 1)) ]] && sep=""
    DEFINE_LINES+="                \"${e}\"${sep}"$'\n'
done

cat > "$VSCODE_DIR/c_cpp_properties.json" <<EOF
{
    "configurations": [
        {
            "name": "media-center (Orange Pi arm64)",
            "compilerPath": "",
            "cStandard": "c17",
            "cppStandard": "c++20",
            "intelliSenseMode": "linux-gcc-arm64",
            "includePath": [
${INCLUDE_LINES%$'\n'}
            ],
            "defines": [
${DEFINE_LINES%$'\n'}
            ]
        }
    ],
    "version": 4
}
EOF

# systemIncludePath: системные каталоги заголовков устройства (в зеркале).
# Нужны, чтобы cpptools резолвил угловые <math.h>/<stdlib.h> и т.п., которые
# подтягиваются изнутри системных заголовков. У этого поля нет аналога в
# c_cpp_properties.json, поэтому задаем его через настройку C_Cpp.default.
log "Генерация .vscode/settings.json (systemIncludePath)"
SYS_LINES=""
for i in "${!GCC_DIRS[@]}"; do
    sep=","
    [[ $i -eq $((${#GCC_DIRS[@]} - 1)) ]] && sep=""
    SYS_LINES+="        \"${SYSROOT_LOCAL}${GCC_DIRS[$i]}\"${sep}"$'\n'
done

SETTINGS_FILE="$VSCODE_DIR/settings.json"
if [ -f "$SETTINGS_FILE" ] && ! grep -q "C_Cpp.default.systemIncludePath" "$SETTINGS_FILE"; then
    err "ВНИМАНИЕ: $SETTINGS_FILE уже существует и будет перезаписан."
    err "Если там есть свои настройки — сохрани их вручную."
fi

cat > "$SETTINGS_FILE" <<EOF
{
    "C_Cpp.default.systemIncludePath": [
${SYS_LINES%$'\n'}
    ]
}
EOF

log "Готово. В VSCode обязательно: 'C/C++: Reset IntelliSense Database' + 'Developer: Reload Window'."
