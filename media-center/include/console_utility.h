#pragma once
#include <iostream>
#include <string_view>

namespace color {

    // Ѕазовые управл€ющие коды ANSI
    inline constexpr std::string_view reset = "\033[0m";
    inline constexpr std::string_view bold = "\033[1m";
    inline constexpr std::string_view dim = "\033[2m";
    inline constexpr std::string_view italic = "\033[3m";
    inline constexpr std::string_view underline = "\033[4m";
    inline constexpr std::string_view inverse = "\033[7m";

    // ќбычные цвета текста
    inline constexpr std::string_view black = "\033[30m";
    inline constexpr std::string_view red = "\033[31m";
    inline constexpr std::string_view green = "\033[32m";
    inline constexpr std::string_view yellow = "\033[33m";
    inline constexpr std::string_view blue = "\033[34m";
    inline constexpr std::string_view magenta = "\033[35m";
    inline constexpr std::string_view cyan = "\033[36m";
    inline constexpr std::string_view white = "\033[37m";

    // яркие цвета текста
    inline constexpr std::string_view bright_black = "\033[90m";
    inline constexpr std::string_view bright_red = "\033[91m";
    inline constexpr std::string_view bright_green = "\033[92m";
    inline constexpr std::string_view bright_yellow = "\033[93m";
    inline constexpr std::string_view bright_blue = "\033[94m";
    inline constexpr std::string_view bright_magenta = "\033[95m";
    inline constexpr std::string_view bright_cyan = "\033[96m";
    inline constexpr std::string_view bright_white = "\033[97m";

    // ÷вет фона
    inline constexpr std::string_view bg_black = "\033[40m";
    inline constexpr std::string_view bg_red = "\033[41m";
    inline constexpr std::string_view bg_green = "\033[42m";
    inline constexpr std::string_view bg_yellow = "\033[43m";
    inline constexpr std::string_view bg_blue = "\033[44m";
    inline constexpr std::string_view bg_magenta = "\033[45m";
    inline constexpr std::string_view bg_cyan = "\033[46m";
    inline constexpr std::string_view bg_white = "\033[47m";

    // 256 цветов: foreground / background
    inline std::string fg256(int code) {
        return "\033[38;5;" + std::to_string(code) + "m";
    }

    inline std::string bg256(int code) {
        return "\033[48;5;" + std::to_string(code) + "m";
    }

    // TrueColor RGB
    inline std::string fg_rgb(int r, int g, int b) {
        return "\033[38;2;" + std::to_string(r) + ";" + std::to_string(g) + ";" + std::to_string(b) + "m";
    }

    inline std::string bg_rgb(int r, int g, int b) {
        return "\033[48;2;" + std::to_string(r) + ";" + std::to_string(g) + ";" + std::to_string(b) + "m";
    }

    // ”тилита дл€ автоматического сброса цвета
    struct scoped {
        std::string_view code;
        scoped(std::string_view c) : code(c) { std::cout << c; }
        ~scoped() { std::cout << reset; }
    };

} // namespace color
