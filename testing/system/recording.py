import statistics
from collections import defaultdict


def packet_span(packets):
    points = sorted(float(packet['pts_time']) for packet in packets if packet.get('pts_time') not in (None, 'N/A'))
    if len(points) < 2:
        return {'verified': bool(points), 'timing_verified': False, 'packets': len(points), 'content_ms': 0, 'cadence_ms': 0, 'holes_ms': []}
    deltas = [b - a for a, b in zip(points, points[1:]) if b > a]
    cadence = statistics.median(deltas) if deltas else 0
    holes = [round(delta * 1000, 2) for delta in deltas if delta > max(.25, cadence * 3)]
    return {'verified': True, 'timing_verified': True, 'packets': len(points), 'first_pts': points[0], 'last_pts': points[-1],
            'content_ms': round((points[-1] - points[0] + cadence) * 1000, 2),
            'cadence_ms': round(cadence * 1000, 2), 'holes_ms': holes,
            'max_gap_ms': round(max(deltas, default=0) * 1000, 2)}


def boundary_gaps(rows, events):
    grouped = defaultdict(list)
    for row in rows:
        grouped[(row['session_uid'], row['camera_id'], row['stream_key'])].append(row)
    gaps = []
    for key, group in grouped.items():
        group.sort(key=lambda row: row['mono_start_ms'])
        for previous, following in zip(group, group[1:]):
            if not previous.get('verified') or not following.get('verified') or previous.get('holes_ms') or previous.get('timing_verified') is False or following.get('timing_verified') is False:
                continue
            gap = following['mono_start_ms'] - previous['mono_start_ms'] - previous['content_ms']
            if gap <= max(250, previous.get('cadence_ms', 0) * 3):
                continue
            start = previous['wall_start_ms'] + previous['content_ms']
            end = following['wall_start_ms']
            expected = [event['reason'] for event in events if event.get('expected_pause')
                        and event['start_ms'] <= end + 1000 and event.get('end_ms', event['start_ms']) >= start - 1000]
            gaps.append({'session': key[0], 'camera': key[1], 'stream': key[2], 'gap_ms': round(gap, 2),
                         'previous': previous['file'], 'following': following['file'], 'expected': bool(expected), 'reasons': expected})
    return gaps
