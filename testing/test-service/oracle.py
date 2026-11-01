def field(value, path):
    for part in path.split('.'):
        if isinstance(value, dict):
            value = value.get(part)
        elif isinstance(value, list) and part.isdigit() and int(part)<len(value):
            value = value[int(part)]
        else:
            return None
    return value


def control_matches(kind, row, identifier):
    value = row['value']
    if kind=='can':
        return row['channel']=='can' and value.get('id')==0x00EF0071 and value.get('data')=='01010302ffffffff' and value.get('extended') is True
    if kind=='modbus':
        return row['channel']=='modbus-records' and all(value.get(key)==expected for key, expected in {'frame': identifier, 'code': 1, 'zone': 3, 'mask': 1, 'count': 1}.items())
    header = value.get('header', {})
    return row['channel']=='ws' and header.get('id')==identifier and header.get('ver')==1 and header.get('type')=='frame' and header.get('cam')=='test-service' and header.get('img')=={'width': 1, 'height': 1, 'format': 'png'} and value.get('image_bytes', 0)>0 and any(det.get('cls')=='person' and det.get('cid')==0 and det.get('box')==[0, 0, 1, 1] for det in header.get('dets', []))


def compare(expectations, journal, trace, play_ms, camera_id):
    received = {'journal': [{'at': row['observed_ms'], 'value': row} for row in journal], 'can': [], 'modbus': [], 'ws': []}
    journal_ids = {row['id'] & 0xffffffff for row in journal}
    for row in trace:
        value = row['value']
        if row['channel']=='can' and value.get('id')==0x00EF0071:
            data = bytes.fromhex(value['data'])
            if len(data)==8 and value.get('extended'):
                received['can'].append({'at': row['wall_ms'], 'value': {'count': data[0], 'type': data[1], 'danger': data[2], 'camera_no': data[3], 'padding': data[4:].hex()}})
        elif row['channel']=='modbus-records' and value.get('frame') in journal_ids:
            received['modbus'].append({'at': row['wall_ms'], 'value': value})
        elif row['channel']=='ws' and value.get('header', {}).get('cam')==camera_id:
            received['ws'].append({'at': row['wall_ms'], 'value': value['header']})
    checks = []
    for expectation in expectations:
        matches = [row for row in received[expectation['channel']] if play_ms+expectation['start']*1000<=row['at']<=play_ms+expectation['end']*1000 and all(field(row['value'], key)==value for key, value in expectation['fields'].items())]
        checks.append({'expected': expectation, 'actual_count': len(matches), 'passed': expectation['minimum']<=len(matches)<=expectation['maximum'], 'matches': matches[:50]})
    return {'passed': bool(checks) and all(row['passed'] for row in checks), 'checks': checks, 'received_counts': {key: len(rows) for key, rows in received.items()}}


def classify_gaps(gaps, rows, pauses):
    files = {(row['session_uid'], row['camera_id'], row['stream_key'], row['file']): row for row in rows}
    for gap in gaps:
        key = (gap['session'], gap['camera'], gap['stream'])
        previous, following = files[(*key, gap['previous'])], files[(*key, gap['following'])]
        reasons = []
        for pause in pauses:
            if not pause.get('expected_pause'):
                continue
            key = (gap['camera'], gap['stream'])
            before = next((r for r in pause.get('before', []) if (r['camera_id'], r['stream_key'])==key), None)
            after = next((r for r in pause.get('after', []) if (r['camera_id'], r['stream_key'])==key), None)
            if before and after and previous['checkpoint_id']==before['checkpoint_id'] and before['checkpoint_id']<following['checkpoint_id']<=after['checkpoint_id'] and gap['gap_ms']<=pause['end_ms']-pause['start_ms']+2000:
                reasons.append(pause['reason'])
        gap.update(expected=bool(reasons), reasons=reasons)
    return gaps
