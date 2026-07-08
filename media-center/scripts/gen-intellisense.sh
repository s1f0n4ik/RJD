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

log "Переписывание путей: $REMOTE_DIR -> $PROJ_LOCAL"
# 1) пути проекта (удаленный корень -> локальный корень)
# 2) оставшиеся абсолютные системные include -> локальное зеркало sysroot
sed \
    -e "s#${REMOTE_DIR}#${PROJ_LOCAL}#g" \
    -e "s#-I/#-I${SYSROOT_LOCAL}/#g" \
    -e "s#-isystem /#-isystem ${SYSROOT_LOCAL}/#g" \
    -e "s#-isystem/#-isystem${SYSROOT_LOCAL}/#g" \
    "$TMP" > "$PROJECT_DIR/compile_commands.json"
rm -f "$TMP"

# Генерация c_cpp_properties.json: compile_commands дает пути проекта/GStreamer/OpenCV,
# includePath добавляет неявные пути gcc (stdlib), которых нет в compile_commands.
log "Генерация .vscode/c_cpp_properties.json"
mkdir -p "$VSCODE_DIR"

# Все элементы includePath: неявные пути gcc (в зеркале) + каталоги проекта.
PATHS=()
for d in "${GCC_DIRS[@]}"; do
    PATHS+=("${SYSROOT_LOCAL}${d}")
done
PATHS+=(
    "\${workspaceFolder}/media-center/include"
    "\${workspaceFolder}/media-center/generated"
    "\${workspaceFolder}/media-center/3rdparty/boost/include"
    "\${workspaceFolder}/media-center/3rdparty/glm"
    "\${workspaceFolder}/media-center/3rdparty/rknn/include"
)

INCLUDE_LINES=""
for i in "${!PATHS[@]}"; do
    sep=","
    [[ $i -eq $((${#PATHS[@]} - 1)) ]] && sep=""
    INCLUDE_LINES+="                \"${PATHS[$i]}\"${sep}"$'\n'
done

cat > "$VSCODE_DIR/c_cpp_properties.json" <<EOF
{
    "configurations": [
        {
            "name": "media-center (Orange Pi arm64)",
            "compileCommands": "\${workspaceFolder}/media-center/compile_commands.json",
            "compilerPath": "",
            "cStandard": "c17",
            "cppStandard": "c++20",
            "intelliSenseMode": "linux-gcc-arm64",
            "includePath": [
${INCLUDE_LINES%$'\n'}
            ]
        }
    ],
    "version": 4
}
EOF

log "Готово. В VSCode при необходимости: 'C/C++: Reset IntelliSense Database'."
