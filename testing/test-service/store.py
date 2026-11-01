import hashlib
import html
import json
import os
import re
import shutil
import time
import threading
from datetime import datetime, timezone
from pathlib import Path


class BudgetError(RuntimeError):
    pass


def now():
    return datetime.now(timezone.utc).isoformat()


def redacted(value):
    if isinstance(value, dict):
        return {k: '[redacted]' if any(word in k.lower() for word in ('password', 'private_key', 'authorization', 'cookie', 'secret', 'token')) else redacted(v) for k, v in value.items()}
    if isinstance(value, list):
        return [redacted(v) for v in value]
    if isinstance(value, str):
        value = re.sub(r'(rtsps?://)[^\s/@]+(?::[^\s/@]*)?@', r'\1[redacted]@', value)
        return re.sub(r'(?i)((?:password|passwd|secret|token)["\s]*[:=]["\s]*)[^",\s}&]+', r'\1[redacted]', value)
    return value


def atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    with temporary.open('w', encoding='utf-8') as out:
        json.dump(value, out, ensure_ascii=False)
        out.flush()
        os.fsync(out.fileno())
    temporary.chmod(0o600)
    temporary.replace(path)
    if os.name != 'nt':
        fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


class Store:
    def __init__(self, root):
        self.root = Path(root)
        for name in ('runs', 'scenarios', 'private'):
            (self.root / name).mkdir(parents=True, exist_ok=True)
        (self.root / 'private').chmod(0o700)
        (self.root / 'private' / 'tmp').mkdir(exist_ok=True)

    def path(self, group, key):
        if group not in ('runs', 'scenarios') or not re.fullmatch(r'[a-z0-9-]{1,80}', key):
            raise ValueError('Invalid identifier')
        return self.root / group / key

    def read(self, path, default=None):
        if not path.exists():
            return default
        return json.loads(path.read_text(encoding='utf-8'))

    def runs(self):
        result = []
        for path in sorted((self.root / 'runs').glob('*/report.json'), reverse=True):
            result.append(self.read(path))
        return result

    def scenarios(self):
        return [self.read(p) for p in sorted((self.root / 'scenarios').glob('*/scenario.json'))]

    def budget(self, reserve_mb):
        free = shutil.disk_usage(self.root).free
        if free < reserve_mb * 1024**2:
            raise BudgetError('Testing volume reserve exhausted')
        return free

    def report(self, value):
        value['updated_at'] = now()
        atomic(self.path('runs', value['id']) / 'report.json', redacted(value))

    def artifact(self, run_id, name, content):
        if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9.-]{0,100}', name):
            raise ValueError('Invalid artifact name')
        value = redacted(content)
        path = self.path('runs', run_id) / name
        atomic(path, value)
        return {'name': name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'bytes': path.stat().st_size}


class Trace:
    def __init__(self, root, limit_mb):
        self.root = root
        self.limit = max(1024, limit_mb * 1024**2 // 2)
        self.sequence = 0
        self.total = 0
        self.rows = []
        self.lock = threading.RLock()
        self.row_sizes = []
        self.memory_bytes = 0

    def add(self, channel, value):
        with self.lock:
            return self.append(channel, value)

    def append(self, channel, value):
        row = {'seq': self.sequence, 'at': now(), 'wall_ms': round(time.time()*1000), 'channel': channel, 'value': redacted(value)}
        self.sequence += 1
        self.total += 1
        encoded = json.dumps(row, ensure_ascii=False)
        if len(encoded.encode())>min(65536, self.limit):
            row['value'] = {'truncated': True, 'sha256': hashlib.sha256(encoded.encode()).hexdigest(), 'preview': encoded[:1000]}
            encoded = json.dumps(row, ensure_ascii=False)
        self.rows.append(row)
        self.row_sizes.append(len(encoded.encode()))
        self.memory_bytes += self.row_sizes[-1]
        while self.memory_bytes>min(self.limit, 16*1024**2) and len(self.rows)>1:
            self.rows.pop(0)
            self.memory_bytes -= self.row_sizes.pop(0)
        path = self.root / 'trace.jsonl'
        if path.exists() and path.stat().st_size > self.limit:
            path.replace(self.root / 'trace-previous.jsonl')
        with path.open('a', encoding='utf-8') as out:
            out.write(encoded + '\n')
        return row


def html_report(report, base_url=''):
    esc = lambda value: html.escape(str(value))
    rows = ''.join(f'<tr><td>{esc(c["title"])}</td><td>{esc(c["status"])}</td><td>{esc(c.get("expected", ""))}</td><td>{esc(c.get("actual", ""))}</td></tr>' for c in report['checks'])
    cleanup = esc(json.dumps(report.get('cleanup', {}), ensure_ascii=False, indent=2))
    artifacts = ''.join(f'<tr><td><a href="{esc(base_url.rstrip("/") + "/api/runs/" + report["id"] + "/artifacts/" + item["name"])}">{esc(item["name"])}</a></td><td>{esc(item["bytes"])}</td><td><code>{esc(item["sha256"])}</code></td></tr>' for item in report.get('artifacts', []))
    metrics = ''.join(f'<details><summary>{esc(item["title"])}</summary><pre>{esc(json.dumps(item.get("metrics", {}), ensure_ascii=False, indent=2))}</pre></details>' for item in report['checks'])
    return f'<!doctype html><html lang="ru"><meta charset="utf-8"><title>{esc(report["id"])}</title><style>body{{font:14px/1.6 system-ui;margin:32px;color:#20252d}}table{{border-collapse:collapse;width:100%}}td,th{{border:1px solid #ccc;padding:10px;text-align:left}}pre,code{{white-space:pre-wrap;overflow-wrap:anywhere}}details{{margin:12px 0}}</style><h1>Испытания {esc(report["target"])}</h1><p>{esc(report["started_at"])} / {esc(report["state"])}</p><table><tr><th>Проверка</th><th>Результат</th><th>Ожидается</th><th>Фактически</th></tr>{rows}</table><h2>Замеры</h2>{metrics}<h2>Доказательства</h2><table><tr><th>Файл</th><th>Байт</th><th>SHA256</th></tr>{artifacts}</table><h2>Восстановление</h2><pre>{cleanup}</pre></html>'
