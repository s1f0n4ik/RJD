// Ошибки шлюз отдаёт текстом системы (errno, boost, beast); интерфейсу нужен русский.
// Замены идут по очереди по всему тексту: известные куски переводятся, остальное остаётся как есть.
const RULES: Array<[RegExp, string]> = [
  [/^write:/i, 'запись:'],
  [/^read:/i, 'чтение:'],
  [/^connect:/i, 'подключение:'],
  [/^resolve:/i, 'разрешение имени:'],
  [/^handshake:/i, 'рукопожатие:'],
  [/^open:/i, 'открытие:'],
  [/^bind:/i, 'привязка:'],
  [/^send:/i, 'отправка:'],
  [/^recv:/i, 'приём:'],
  [/^ioctl:/i, 'настройка интерфейса:'],
  [/^resolve failed:/i, 'имя не разрешилось:'],
  [/^connect failed:/i, 'подключение не удалось:'],
  [/^handshake failed:/i, 'рукопожатие не удалось:'],
  [/^read failed:/i, 'чтение оборвалось:'],
  [/^write failed:/i, 'запись оборвалась:'],
  [/interface '([^']+)' not found/i, "интерфейс '$1' не найден"],
  [/device '([^']+)' not found/i, "устройство '$1' не найдено"],
  [/connection refused/i, 'соединение отклонено'],
  [/timed? ?out/i, 'истекло время ожидания'],
  [/no route to host/i, 'нет маршрута до хоста'],
  [/network (is )?unreachable/i, 'сеть недоступна'],
  [/network is down/i, 'интерфейс не поднят'],
  [/host is down/i, 'хост выключен'],
  [/host (is )?unreachable/i, 'хост недоступен'],
  [/broken pipe/i, 'соединение разорвано'],
  [/connection reset/i, 'соединение сброшено'],
  [/end of file|\beof\b/i, 'соединение закрыто удалённой стороной'],
  [/partial message/i, 'ответ не по протоколу WebSocket'],
  [/bad (http )?response|upgrade (header )?required|invalid (http )?response/i, 'ответ не по протоколу WebSocket'],
  [/no buffer space available/i, 'буфер шины переполнен'],
  [/no such device/i, 'устройства нет в системе'],
  [/no such file or directory/i, 'файл устройства не найден'],
  [/permission denied|operation not permitted/i, 'нет прав доступа'],
  [/device or resource busy/i, 'устройство занято'],
  [/bad file descriptor/i, 'дескриптор закрыт'],
  [/unsupported (protocol )?version/i, 'версия протокола не поддерживается'],
  [/not connected/i, 'нет соединения'],
  [/no delivery modules/i, 'нет модулей доставки'],
  [/name or service not known|host not found|temporary failure in name resolution/i, 'имя хоста не разрешается'],
  [/operation canceled|operation aborted/i, 'операция прервана'],
];

export function humanizeError(raw: string | undefined | null): string {
  if (!raw) return '';
  return RULES.reduce((text, [re, to]) => text.replace(re, to), raw.trim());
}
