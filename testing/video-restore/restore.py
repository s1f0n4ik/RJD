#!/usr/bin/env python3
"""Восстановление mp4 без moov и склейка сегментов в ролики до 20 минут."""

import argparse
import datetime
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor

NAME_RX = re.compile(
    r'^(?P<cam>.+?)_(?P<y>\d{4})-(?P<mo>\d{2})-(?P<d>\d{2})_'
    r'(?P<h>\d{2})-(?P<mi>\d{2})-(?P<s>\d{2})\.mp4$', re.IGNORECASE)

GROUP_SECONDS = 1200.0
GAP_SECONDS = 90.0
STATE_NAME = 'restore-state.json'
MERGED_DIR = 'merged'
BAK_SUFFIX = '.bak'
MAX_NAL = 64 * 1024 * 1024
REPAIR_FPS = 25
REPAIR_TIMESCALE = 2500

FFMPEG_HINTS = [
    os.environ.get('FFMPEG_DIR'),
    r'C:\Program Files\Ffmpeg\bin',
    r'C:\Program Files\ffmpeg\bin',
    r'C:\ffmpeg\bin',
]


# ---------------------------------------------------------------- инструменты

def find_tool(name):
    found = shutil.which(name)
    if found:
        return found
    exe = name + ('.exe' if os.name == 'nt' else '')
    for d in FFMPEG_HINTS:
        if d and os.path.isfile(os.path.join(d, exe)):
            return os.path.join(d, exe)
    raise SystemExit(f'не найден {name}: добавь в PATH или задай FFMPEG_DIR')


FFMPEG = None
FFPROBE = None


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True,
                          encoding='utf-8', errors='replace')


# ------------------------------------------------------------------- разбор

def read_mvhd_duration(f, start, end):
    off = start
    while off + 8 <= end:
        f.seek(off)
        hdr = f.read(8)
        if len(hdr) < 8:
            return None
        sz = struct.unpack('>I', hdr[:4])[0]
        typ = hdr[4:8]
        hsz = 8
        if sz == 1:
            ext = f.read(8)
            if len(ext) < 8:
                return None
            sz = struct.unpack('>Q', ext)[0]
            hsz = 16
        elif sz == 0:
            sz = end - off
        if sz < hsz or off + sz > end:
            return None
        if typ == b'mvhd':
            f.seek(off + hsz)
            ver = f.read(4)[0]
            if ver == 1:
                body = f.read(28)
                timescale, duration = struct.unpack('>IQ', body[16:28])
            else:
                body = f.read(16)
                timescale, duration = struct.unpack('>II', body[8:16])
            return duration / timescale if timescale else None
        off += sz
    return None


STBL_PATH = (b'moov', b'trak', b'mdia', b'minf', b'stbl')


def read_sample_count(f, start, end):
    """Число кадров из stsz видеодорожки."""
    off = start
    while off + 8 <= end:
        f.seek(off)
        hdr = f.read(8)
        if len(hdr) < 8:
            return None
        sz = struct.unpack('>I', hdr[:4])[0]
        typ = hdr[4:8]
        hsz = 8
        if sz == 1:
            ext = f.read(8)
            if len(ext) < 8:
                return None
            sz = struct.unpack('>Q', ext)[0]
            hsz = 16
        elif sz == 0:
            sz = end - off
        if sz < hsz or off + sz > end:
            return None
        if typ == b'stsz':
            f.seek(off + hsz + 8)
            raw = f.read(4)
            return struct.unpack('>I', raw)[0] if len(raw) == 4 else None
        if typ in STBL_PATH:
            got = read_sample_count(f, off + hsz, off + sz)
            if got is not None:
                return got
        off += sz
    return None


def scan_file(path):
    """Классифицирует mp4 по верхнеуровневым атомам, читая только заголовки."""
    info = {'path': path, 'size': 0, 'verdict': 'error',
            'mdat': None, 'duration': None, 'frames': None}
    try:
        info['size'] = os.path.getsize(path)
    except OSError:
        return info
    if info['size'] == 0:
        info['verdict'] = 'empty'
        return info
    total = info['size']
    try:
        with open(path, 'rb') as f:
            off = 0
            moov = None
            while off < total:
                f.seek(off)
                hdr = f.read(8)
                if len(hdr) < 8:
                    info['verdict'] = 'trunc_header'
                    return info
                sz = struct.unpack('>I', hdr[:4])[0]
                typ = hdr[4:8].decode('latin1', 'replace')
                hsz = 8
                if sz == 1:
                    ext = f.read(8)
                    if len(ext) < 8:
                        info['verdict'] = 'trunc_header'
                        return info
                    sz = struct.unpack('>Q', ext)[0]
                    hsz = 16
                elif sz == 0:
                    # mdat без длины тянется до конца файла: moov не дописан
                    if typ == 'mdat':
                        info['verdict'] = 'mdat_open'
                        info['mdat'] = (off + hsz, total)
                        return info
                    sz = total - off
                if sz < hsz:
                    info['verdict'] = 'bad_size'
                    return info
                if off + sz > total:
                    info['verdict'] = 'atom_overrun'
                    if typ == 'mdat':
                        info['mdat'] = (off + hsz, total)
                    return info
                if typ == 'mdat':
                    info['mdat'] = (off + hsz, off + sz)
                elif typ == 'moov':
                    moov = (off + hsz, off + sz)
                off += sz
            if moov is None:
                info['verdict'] = 'no_moov'
                return info
            info['verdict'] = 'ok'
            info['duration'] = read_mvhd_duration(f, *moov)
            info['frames'] = read_sample_count(f, *moov)
    except OSError as e:
        info['verdict'] = 'error'
        info['error'] = str(e)
    return info


REPAIRABLE = {'mdat_open', 'atom_overrun', 'no_moov', 'trunc_header', 'bad_size'}


def scan_tree(root):
    cams = {}
    for cam in sorted(os.listdir(root)):
        d = os.path.join(root, cam)
        if not os.path.isdir(d) or cam == MERGED_DIR:
            continue
        names = [n for n in sorted(os.listdir(d)) if n.lower().endswith('.mp4')]
        if not names:
            continue
        cams[cam] = [scan_file(os.path.join(d, n)) for n in names]
    return cams


def verdict_counts(files):
    counts = {}
    for r in files:
        counts[r['verdict']] = counts.get(r['verdict'], 0) + 1
    return counts


def save_state(root, cams):
    path = os.path.join(root, STATE_NAME)
    payload = {'root': root, 'cameras': {c: verdict_counts(v) for c, v in cams.items()},
               'files': {c: [{'name': os.path.basename(r['path']),
                              'verdict': r['verdict'], 'size': r['size'],
                              'duration': r['duration']} for r in v]
                         for c, v in cams.items()}}
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    return path


# -------------------------------------------------------------------- ремонт

def extract_nals(f, start, end):
    """Цепочка NAL с 4-байтным префиксом длины; обрывается на неполном."""
    nals = []
    off = start
    truncated = False
    while off + 4 <= end:
        f.seek(off)
        b = f.read(4)
        if len(b) < 4:
            truncated = True
            break
        ln = struct.unpack('>I', b)[0]
        if ln == 0 or ln > MAX_NAL:
            truncated = True
            break
        if off + 4 + ln > end:
            truncated = True
            break
        nals.append((off + 4, ln))
        off += 4 + ln
    if off < end:
        truncated = True
    return nals, truncated


def write_annexb(src, nals, dst):
    with open(src, 'rb') as f, open(dst, 'wb') as out:
        for off, ln in nals:
            out.write(b'\x00\x00\x00\x01')
            f.seek(off)
            left = ln
            while left:
                chunk = f.read(min(left, 1 << 20))
                if not chunk:
                    break
                out.write(chunk)
                left -= len(chunk)


def probe_frames(path):
    r = run([FFPROBE, '-v', 'error', '-select_streams', 'v:0',
             '-show_entries', 'stream=nb_frames,duration',
             '-of', 'default=noprint_wrappers=1:nokey=0', path])
    if r.returncode != 0:
        return None, None, r.stderr.strip()
    frames = duration = None
    for line in r.stdout.splitlines():
        k, _, v = line.partition('=')
        if k == 'nb_frames' and v.isdigit():
            frames = int(v)
        elif k == 'duration':
            try:
                duration = float(v)
            except ValueError:
                pass
    return frames, duration, None


def repair_one(rec, tmpdir, apply):
    """Собирает Annex-B из уцелевших NAL и ремуксит в mp4 с тегом hvc1."""
    path = rec['path']
    name = os.path.basename(path)
    res = {'name': name, 'action': None, 'frames': 0, 'note': ''}

    if rec['verdict'] == 'empty':
        res['action'] = 'delete'
        res['note'] = '0 байт'
        if apply:
            os.remove(path)
        return res

    if not rec['mdat']:
        res['action'] = 'delete'
        res['note'] = 'mdat не найден'
        if apply:
            os.remove(path)
        return res

    start, end = rec['mdat']
    with open(path, 'rb') as f:
        nals, truncated = extract_nals(f, start, end)
    if not nals:
        res['action'] = 'delete'
        res['note'] = 'ни одного целого NAL'
        if apply:
            os.remove(path)
        return res

    res['note'] = f'{len(nals)} NAL' + (', хвост обрезан' if truncated else '')
    if not apply:
        res['action'] = 'repair'
        return res

    raw = os.path.join(tmpdir, name + '.h265')
    fixed = os.path.join(tmpdir, name)
    try:
        write_annexb(path, nals, raw)
        r = run([FFMPEG, '-y', '-v', 'error', '-r', str(REPAIR_FPS),
                 '-f', 'hevc', '-i', raw, '-c', 'copy', '-tag:v', 'hvc1',
                 '-video_track_timescale', str(REPAIR_TIMESCALE), fixed])
        if r.returncode != 0 or not os.path.exists(fixed):
            res['action'] = 'failed'
            res['note'] = 'ремукс: ' + (r.stderr.strip().splitlines() or ['?'])[-1]
            return res

        frames, _, err = probe_frames(fixed)
        if err or not frames:
            res['action'] = 'delete'
            res['note'] = 'после ремукса ноль кадров'
            os.remove(path)
            return res

        # полная проверка декодом: любой вывод в stderr означает битый поток
        v = run([FFMPEG, '-v', 'error', '-i', fixed, '-f', 'null', '-'])
        if v.returncode != 0 or v.stderr.strip():
            res['action'] = 'failed'
            res['note'] = 'декод: ' + (v.stderr.strip().splitlines() or ['?'])[0]
            return res

        bak = path + BAK_SUFFIX
        if os.path.exists(bak):
            os.remove(bak)
        os.replace(path, bak)
        shutil.move(fixed, path)
        res['action'] = 'repaired'
        res['frames'] = frames
    finally:
        for p in (raw, fixed):
            if os.path.exists(p):
                try:
                    os.remove(p)
                except OSError:
                    pass
    return res


# ------------------------------------------------------------------- склейка

def parse_start(name):
    m = NAME_RX.match(name)
    if not m:
        return None
    g = m.groupdict()
    return datetime.datetime(int(g['y']), int(g['mo']), int(g['d']),
                             int(g['h']), int(g['mi']), int(g['s']))


def build_groups(files):
    """Группа закрывается по 20 минутам видео или по разрыву между сегментами."""
    items = []
    for r in files:
        if r['verdict'] != 'ok':
            continue
        start = parse_start(os.path.basename(r['path']))
        if start is None:
            continue
        items.append({'path': r['path'], 'start': start,
                      'duration': r['duration'] or 60.0})
    items.sort(key=lambda i: i['start'])

    groups = []
    cur = []
    total = 0.0
    for it in items:
        if cur:
            gap = (it['start'] - cur[-1]['start']).total_seconds() - cur[-1]['duration']
            if gap > GAP_SECONDS or total + it['duration'] > GROUP_SECONDS:
                groups.append(cur)
                cur, total = [], 0.0
        cur.append(it)
        total += it['duration']
    if cur:
        groups.append(cur)
    return groups


def group_name(cam, group):
    start = group[0]['start']
    dur = sum(i['duration'] for i in group)
    return (f'{cam}_{start:%Y-%m-%d_%H-%M-%S}_{int(round(dur)):04d}s')


def write_concat_list(group, path):
    with open(path, 'w', encoding='utf-8') as f:
        for it in group:
            p = os.path.abspath(it['path']).replace('\\', '/').replace("'", r"'\''")
            f.write(f"file '{p}'\n")


def write_sidecar(path, cam, group, skipped, actual):
    start = group[0]['start']
    expected = sum(i['duration'] for i in group)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(f'camera:     {cam}\n')
        f.write(f'start:      {start:%Y-%m-%d %H:%M:%S}\n')
        f.write(f'segments:   {len(group)}\n')
        f.write(f'expected_s: {expected:.3f}\n')
        f.write(f'actual_s:   {actual if actual is None else round(actual, 3)}\n\n')
        f.write(f'{"offset_s":>10}  {"wall_clock":19}  {"dur_s":>7}  source\n')
        off = 0.0
        for it in group:
            f.write(f'{off:10.3f}  {it["start"]:%Y-%m-%d %H:%M:%S}  '
                    f'{it["duration"]:7.3f}  {os.path.basename(it["path"])}\n')
            off += it['duration']
        if skipped:
            f.write('\nпропущены как битые:\n')
            for name, verdict in skipped:
                f.write(f'  {name}  {verdict}\n')


def merge_group(cam, group, out_dir, skipped, tmpdir, apply):
    base = group_name(cam, group)
    out_mp4 = os.path.join(out_dir, base + '.mp4')
    out_txt = os.path.join(out_dir, base + '.txt')
    expected = sum(i['duration'] for i in group)
    res = {'name': base, 'segments': len(group), 'expected': expected}

    if os.path.exists(out_mp4):
        _, dur, err = probe_frames(out_mp4)
        if not err and dur and abs(dur - expected) <= 2.0:
            res['action'] = 'skip'
            return res

    if not apply:
        res['action'] = 'merge'
        return res

    os.makedirs(out_dir, exist_ok=True)
    lst = os.path.join(tmpdir, base + '.txt')
    write_concat_list(group, lst)
    part = out_mp4 + '.part'
    # -f mp4 обязателен: по расширению .part муксер не определяется
    r = run([FFMPEG, '-y', '-v', 'error', '-f', 'concat', '-safe', '0',
             '-i', lst, '-c', 'copy', '-tag:v', 'hvc1', '-f', 'mp4', part])
    try:
        os.remove(lst)
    except OSError:
        pass
    if r.returncode != 0 or not os.path.exists(part):
        res['action'] = 'failed'
        res['note'] = (r.stderr.strip().splitlines() or ['?'])[-1]
        if os.path.exists(part):
            os.remove(part)
        return res

    _, dur, err = probe_frames(part)
    if err or dur is None:
        res['action'] = 'failed'
        res['note'] = 'ffprobe не прочитал результат'
        os.remove(part)
        return res
    if abs(dur - expected) > 2.0:
        res['action'] = 'failed'
        res['note'] = f'длительность {dur:.1f}s против ожидаемых {expected:.1f}s'
        os.remove(part)
        return res

    os.replace(part, out_mp4)
    write_sidecar(out_txt, cam, group, skipped, dur)
    res['action'] = 'merged'
    res['actual'] = dur
    return res


# ------------------------------------------------------------------- команды

def cmd_scan(args):
    cams = scan_tree(args.root)
    total = {}
    for cam, files in cams.items():
        counts = verdict_counts(files)
        for k, v in counts.items():
            total[k] = total.get(k, 0) + v
        hours = sum(r['duration'] or 0 for r in files) / 3600
        print(f'{cam}: {len(files)} файлов, {hours:.1f} ч  {counts}')
    print(f'\nвсего: {total}')
    print('состояние:', save_state(args.root, cams))
    return 0


def cmd_repair(args):
    cams = scan_tree(args.root)
    todo = [(cam, r) for cam, files in cams.items() for r in files
            if r['verdict'] != 'ok']
    if not todo:
        print('битых файлов нет')
        return 0

    print(f'битых файлов: {len(todo)}' + ('' if args.apply else '  (пробный прогон)'))
    tmpdir = args.tmp or os.path.join(tempfile.gettempdir(), 'video-restore')
    os.makedirs(tmpdir, exist_ok=True)

    stats = {}
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futures = [pool.submit(repair_one, r, tmpdir, args.apply)
                   for _, r in todo]
        for i, fut in enumerate(futures, 1):
            res = fut.result()
            stats[res['action']] = stats.get(res['action'], 0) + 1
            print(f'[{i}/{len(todo)}] {res["action"]:8} {res["name"]}'
                  + (f'  {res["note"]}' if res['note'] else ''))
    print('\nитог:', stats)
    if not args.apply:
        print('ничего не изменено, повтори с --apply')
    else:
        save_state(args.root, scan_tree(args.root))
    return 0


def cmd_merge(args):
    cams = scan_tree(args.root)
    tmpdir = args.tmp or os.path.join(tempfile.gettempdir(), 'video-restore')
    os.makedirs(tmpdir, exist_ok=True)
    out_root = args.out or os.path.join(args.root, MERGED_DIR)

    plan = []
    for cam, files in cams.items():
        skipped = [(os.path.basename(r['path']), r['verdict'])
                   for r in files if r['verdict'] != 'ok']
        if skipped:
            print(f'ВНИМАНИЕ {cam}: пропущено битых файлов {len(skipped)}, '
                  f'сначала прогони repair')
        for g in build_groups(files):
            plan.append((cam, g, os.path.join(out_root, cam), skipped))

    total_s = sum(sum(i['duration'] for i in g) for _, g, _, _ in plan)
    print(f'групп: {len(plan)}, суммарно {total_s / 3600:.1f} ч'
          + ('' if args.apply else '  (пробный прогон)'))

    stats = {}
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futures = [pool.submit(merge_group, cam, g, d, sk, tmpdir, args.apply)
                   for cam, g, d, sk in plan]
        for i, fut in enumerate(futures, 1):
            res = fut.result()
            stats[res['action']] = stats.get(res['action'], 0) + 1
            line = (f'[{i}/{len(plan)}] {res["action"]:7} {res["name"]}  '
                    f'{res["segments"]} сегм., {res["expected"]:.0f}s')
            if res.get('note'):
                line += '  ' + res['note']
            print(line)
    print('\nитог:', stats)
    if not args.apply:
        print('ничего не записано, повтори с --apply')
    return 0


SIDECAR_RX = re.compile(
    r'^\s*[\d.]+\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s+[\d.]+\s+(\S+\.mp4)$')


def cmd_verify(args):
    """Покадровая сверка склеек с исходниками через stsz, без декодирования."""
    out_root = args.out or os.path.join(args.root, MERGED_DIR)
    if not os.path.isdir(out_root):
        raise SystemExit(f'нет каталога {out_root}')

    src = {}
    for cam in sorted(os.listdir(args.root)):
        d = os.path.join(args.root, cam)
        if not os.path.isdir(d) or cam == MERGED_DIR:
            continue
        for n in sorted(os.listdir(d)):
            if n.lower().endswith('.mp4'):
                src[(cam, n)] = scan_file(os.path.join(d, n))
    print(f'исходников: {len(src)}, кадров '
          f'{sum(r["frames"] or 0 for r in src.values())}')

    used = set()
    problems = []
    groups = merged_frames = 0
    for cam in sorted(os.listdir(out_root)):
        d = os.path.join(out_root, cam)
        if not os.path.isdir(d):
            continue
        for n in sorted(os.listdir(d)):
            if not n.endswith('.txt'):
                continue
            mp4 = os.path.join(d, n[:-4] + '.mp4')
            if not os.path.exists(mp4):
                problems.append((n, 'нет mp4'))
                continue
            names = [m.group(1) for m in
                     (SIDECAR_RX.match(l) for l in
                      open(os.path.join(d, n), encoding='utf-8').read().splitlines())
                     if m]
            expect = 0
            for s in names:
                rec = src.get((cam, s))
                if rec is None:
                    problems.append((n, f'исходник пропал: {s}'))
                    continue
                if (cam, s) in used:
                    problems.append((n, f'сегмент использован дважды: {s}'))
                used.add((cam, s))
                expect += rec['frames'] or 0
            got = scan_file(mp4)['frames'] or 0
            merged_frames += got
            groups += 1
            if got != expect:
                problems.append((n, f'кадров {got} против {expect} '
                                    f'({got - expect:+d})'))

    print(f'склеек: {groups}, кадров {merged_frames}')
    missing = sorted(set(src) - used)
    print(f'исходников вне склеек: {len(missing)}')
    for cam, n in missing[:10]:
        print(f'  {cam}/{n}')
    print(f'расхождений: {len(problems)}')
    for n, why in problems[:20]:
        print(f'  {n}: {why}')
    return 1 if problems or missing else 0


def cmd_clean_bak(args):
    baks = []
    for cam in sorted(os.listdir(args.root)):
        d = os.path.join(args.root, cam)
        if not os.path.isdir(d) or cam == MERGED_DIR:
            continue
        for n in sorted(os.listdir(d)):
            if n.endswith('.mp4' + BAK_SUFFIX):
                baks.append(os.path.join(d, n))
    if not baks:
        print('.bak не найдено')
        return 0

    freed = removed = kept = 0
    for b in baks:
        target = b[:-len(BAK_SUFFIX)]
        info = scan_file(target) if os.path.exists(target) else None
        if not info or info['verdict'] != 'ok':
            print(f'оставлен {os.path.basename(b)}: рядом нет исправного mp4')
            kept += 1
            continue
        size = os.path.getsize(b)
        if args.apply:
            os.remove(b)
        freed += size
        removed += 1
    print(f'{"удалено" if args.apply else "будет удалено"}: {removed}, '
          f'{freed / 1024 ** 3:.2f} ГБ; оставлено: {kept}')
    if not args.apply:
        print('повтори с --apply')
    return 0


def main():
    global FFMPEG, FFPROBE
    # построчный вывод: иначе прогресс не виден при перенаправлении в лог
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except AttributeError:
        pass
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest='cmd', required=True)

    def common(sp, jobs):
        sp.add_argument('root')
        sp.add_argument('--apply', action='store_true')
        sp.add_argument('--jobs', type=int, default=jobs)
        sp.add_argument('--tmp')

    s = sub.add_parser('scan', help='классифицировать все mp4')
    s.add_argument('root')
    s.set_defaults(func=cmd_scan)

    s = sub.add_parser('repair', help='починить битые, удалить безнадёжные')
    common(s, 4)
    s.set_defaults(func=cmd_repair)

    s = sub.add_parser('merge', help='склеить сегменты в ролики до 20 минут')
    common(s, 1)
    s.add_argument('--out')
    s.set_defaults(func=cmd_merge)

    s = sub.add_parser('verify', help='сверить склейки с исходниками покадрово')
    s.add_argument('root')
    s.add_argument('--out')
    s.set_defaults(func=cmd_verify)

    s = sub.add_parser('clean-bak', help='удалить .mp4.bak после проверки')
    s.add_argument('root')
    s.add_argument('--apply', action='store_true')
    s.set_defaults(func=cmd_clean_bak)

    args = p.parse_args()
    args.root = os.path.abspath(args.root)
    if not os.path.isdir(args.root):
        raise SystemExit(f'нет каталога {args.root}')
    FFMPEG = find_tool('ffmpeg')
    FFPROBE = find_tool('ffprobe')
    return args.func(args)


if __name__ == '__main__':
    sys.exit(main())
