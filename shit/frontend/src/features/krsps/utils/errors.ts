// Ошибки шлюз отдаёт текстом системы (errno, boost); интерфейсу нужен русский

const OPS: Record<string, string> = {
  write: 'запись',
  read: 'чтение',
  connect: 'подключение',
  resolve: 'разрешение имени',
  handshake: 'рукопожатие',
  open: 'открытие',
  bind: 'привязка',
  send: 'отправка',
  recv: 'приём',
  ioctl: 'настройка интерфейса',
};

// Порядок важен: первое совпадение подстроки побеждает
const MESSAGES: Array<[RegExp, string]> = [
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
  [/no buffer space available/i, 'буфер шины переполнен'],
  [/no such device/i, 'устройство не найдено'],
  [/no such file or directory/i, 'файл устройства не найден'],
  [/permission denied|operation not permitted/i, 'нет прав доступа'],
  [/device or resource busy/i, 'устройство занято'],
  [/bad file descriptor/i, 'дескриптор закрыт'],
  [/unsupported (protocol )?version/i, 'версия протокола не поддерживается'],
  [/not connected/i, 'нет соединения'],
  [/no delivery modules/i, 'нет модулей доставки'],
  [/name or service not known|host not found|temporary failure in name resolution/i, 'имя хоста не разрешается'],
  [/handshake/i, 'рукопожатие WebSocket не удалось'],
  [/operation canceled|operation aborted/i, 'операция прервана'],
];

export function humanizeError(raw: string | undefined | null): string {
  if (!raw) return '';
  const m = /^(\w+):\s*(.*)$/.exec(raw.trim());
  const op = m && OPS[m[1].toLowerCase()];
  const rest = m && op ? m[2] : raw.trim();
  const hit = MESSAGES.find(([re]) => re.test(rest));
  const text = hit ? hit[1] : rest;
  return op ? `${op}: ${text}` : text;
}
