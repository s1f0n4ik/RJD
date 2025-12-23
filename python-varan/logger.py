import logging
import sys
import os

try:
    if os.name == "nt":
        import colorama
        colorama.init()
except Exception:
    pass

RESET = "\033[0m"
COLORS = {
    "green": "\033[32m",
    "red": "\033[31m",
    "yellow": "\033[33m",
    "cyan": "\033[36m",
    "blue": "\033[34m",
    "magenta": "\033[35m",
    "white": "\033[37m",
}

LEVEL_COLOR = {
    logging.DEBUG: COLORS["cyan"],
    logging.INFO: COLORS["green"],
    logging.WARNING: COLORS["yellow"],
    logging.ERROR: COLORS["red"],
    logging.CRITICAL: COLORS["magenta"],
}


class ColoredFormatter(logging.Formatter):
    def __init__(self, fmt=None, datefmt=None, use_color=True):
        super().__init__(fmt or "[%(asctime)s] [%(levelname)s] %(name)s: %(message)s",
                         datefmt or "%Y-%m-%d %H:%M:%S")
        self.use_color = use_color

    def format(self, record):
        msg = super().format(record)
        if not self.use_color:
            return msg

        color = LEVEL_COLOR.get(record.levelno, "")
        if color:
            time = self.formatTime(record, self.datefmt)
            level = record.levelname
            name = record.name
            message = record.getMessage()
            return f"[{time}] [{color}{level}{RESET}] {name}: {message}"

        return msg


class ColoredLogger(logging.Logger):
    """
    Расширенный логгер:
      - c(text, color) — раскрасить строку
      - action_send(text)
      - action_recv(text)
      - action_error(text)
    """

    def c(self, text: str, color: str):
        """Окрасить строку выбранным цветом."""
        return COLORS.get(color, "") + text + RESET

    def action_send(self, text: str):
        """Лог действий отправки."""
        self.info(COLORS["cyan"] + "[SEND] " + text + RESET)

    def action_recv(self, text: str):
        """Лог действий приема."""
        self.info(COLORS["magenta"] + "[RECV] " + text + RESET)

    def action_error(self, text: str):
        """Лог действий ошибки."""
        self.error(COLORS["red"] + "[ERR] " + text + RESET)


def get_logger(name: str,
               level=logging.DEBUG,
               to_file=None,
               file_level=logging.DEBUG,
               use_color=True):
    logging.setLoggerClass(ColoredLogger)
    logger = logging.getLogger(name)
    logger.setLevel(level)

    if logger.handlers:
        logger.handlers.clear()

    ch = logging.StreamHandler(sys.stdout)
    ch.setLevel(level)
    ch.setFormatter(ColoredFormatter(use_color=use_color))
    logger.addHandler(ch)

    if to_file:
        fh = logging.FileHandler(to_file, encoding="utf-8")
        fh.setLevel(file_level)
        fh.setFormatter(logging.Formatter(
            "[%(asctime)s] [%(levelname)s] %(name)s: %(message)s"
        ))
        logger.addHandler(fh)

    return logger

class NullLogger:
    def debug(self, *args, **kwargs): pass
    def info(self, *args, **kwargs): pass
    def warning(self, *args, **kwargs): pass
    def error(self, *args, **kwargs): pass
    def critical(self, *args, **kwargs): pass

    # кастомные методы
    def c(self, text, color): return text
    def action_send(self, text): pass
    def action_recv(self, text): pass
    def action_error(self, text): pass
