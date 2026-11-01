import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path


def now():
    return datetime.now(timezone.utc).isoformat()


def sanitized(value):
    if isinstance(value, dict):
        return {key: '[redacted]' if key.lower() in ('password', 'credential', 'authorization') else sanitized(item) for key,item in value.items()}
    if isinstance(value, list):
        return [sanitized(item) for item in value]
    if isinstance(value, str):
        return re.sub(r'(rtsps?://)[^\s/@]+(?::[^\s/@]*)?@',r'\1[redacted]@',value)
    return value


class Report:
    def __init__(self, root: Path, run_id: str, target: str):
        self.root=root/run_id
        self.root.mkdir(parents=True,exist_ok=False)
        self.started=time.monotonic()
        self.data={'schema_version':1,'id':run_id,'target':target,'started_at':now(),'state':'running','phase':'Подготовка',
                   'progress':0,'checks':[],'samples':[],'events':[],'artifacts':[],'cleanup':{}}
        self.save()

    def save(self):
        self.data['updated_at']=now()
        self.data['duration_seconds']=round(time.monotonic()-self.started,1)
        temporary=self.root/'report.json.tmp'
        with temporary.open('w',encoding='utf-8') as output:
            json.dump(sanitized(self.data),output,ensure_ascii=False,indent=1)
            output.flush()
            os.fsync(output.fileno())
        temporary.replace(self.root/'report.json')

    def check(self, block, key, title, status, summary, **metrics):
        if any(item['id']==key for item in self.data['checks']):
            raise ValueError('A check result must not overwrite an earlier attempt')
        result={'block':block,'id':key,'title':title,'status':status,'summary':summary,'at':now(),'metrics':sanitized(metrics)}
        self.data['checks'].append(result)
        self.save()
        print(json.dumps({'check':key,'status':status,'summary':summary},ensure_ascii=True),flush=True)
        return result

    def artifact(self, name, label, value):
        if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}',name):
            raise ValueError('Invalid evidence filename')
        content=json.dumps(sanitized(value),ensure_ascii=False,indent=1) if not isinstance(value, str) else sanitized(value)
        (self.root/name).write_text(content,encoding='utf-8')
        self.data['artifacts'].append({'name':name,'label':label})
        self.save()
