import argparse
import copy
import hashlib
import io
import json
import os
import shlex
import subprocess
import sys
import threading
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from report import Report, now

BASE='http://192.168.1.102'
MC=BASE+':7777'
ZONE='/home/orangepi/media-center/codex'
PUBLISH='/var/lib/varan/settings/test-reports'
SSH=['ssh','-o','BatchMode=yes','-o','ConnectTimeout=8','-o','ServerAliveInterval=10','-o','ServerAliveCountMax=2','orangepi-mc']


def request(method,path,body=None,base=BASE,timeout=180,content_type='application/json'):
    data=body if isinstance(body,bytes) else None if body is None else json.dumps(body).encode()
    req=urllib.request.Request(base+path,data=data,method=method,headers={'Content-Type':content_type})
    try:
        with urllib.request.urlopen(req,timeout=timeout) as response:
            result=json.load(response)
    except urllib.error.HTTPError as error:
        try:
            detail=json.load(error)
            message=detail.get('error') or detail.get('detail') or str(error.code)
            if not isinstance(message,str): message='; '.join(item.get('msg','Invalid input') for item in message if isinstance(item,dict))
        except (ValueError,AttributeError):
            message=str(error.code)
        raise RuntimeError(f'{method} {path}: {message}') from error
    return result.get('data',result) if isinstance(result,dict) else result


def storage_headroom(snapshot,required):
    internal=next((item for item in snapshot.get('volumes',[]) if item.get('internal')),None)
    if not internal or internal.get('state')!='online':raise RuntimeError('Cannot verify the production cleaner budget')
    if snapshot.get('target',{}).get('volume_id')!=internal['id']:
        raise RuntimeError('Test recording isolation is validated only for the internal target')
    total,used,high=(internal.get(key) for key in ('total_bytes','used_bytes','high'))
    if any(not isinstance(value,(int,float)) or isinstance(value,bool) for value in (total,used,high)) or total<=0 or used<0 or not 0<high<=100:
        raise RuntimeError('Invalid production storage accounting')
    summary=snapshot.get('summary',{})
    reserve,journal=(summary.get(key) for key in ('journal_reserve_bytes','journal_bytes'))
    if any(not isinstance(value,(int,float)) or isinstance(value,bool) or value<0 for value in (reserve,journal)):
        raise RuntimeError('Cannot verify the journal storage reserve')
    used+=max(0,reserve-journal)
    margin=total*high/100-used
    if margin<required:raise RuntimeError(f'Production cleaner headroom {margin/1024**3:.2f} GiB is below the required {required/1024**3:.2f} GiB')
    return {'volume_id':internal['id'],'high':high,'headroom_bytes':round(margin),'used_bytes_with_reserve':used,'total_bytes':total,'export_discount_applied':False}


class Suite:
    def __init__(self,args):
        stamp=datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')
        self.id='run-'+stamp+'-'+uuid.uuid4().hex[:6]
        self.report=Report(args.results,self.id,'192.168.1.102')
        self.minutes=args.minutes
        self.original=None
        self.original_id=None
        self.device=None
        self.profile_id='test-'+self.id
        self.heartbeat_stop=threading.Event()
        self.heartbeat=None
        self.last_publish=0
        self.browser=None
        self.slot_state=[]
        self.profile_touched=False
        self.clone_created=False
        self.clock_offset_ms=0
        self.published_artifacts=set()

    def ssh(self,command,data=b'',timeout=300):
        result=subprocess.run(SSH+[command],input=data,capture_output=True,timeout=timeout)
        if result.returncode:
            raise RuntimeError(result.stderr.decode(errors='replace')[-1800:] or 'Remote command failed')
        return result.stdout

    def rpc(self,operation,payload=None,root=False):
        command=shlex.join(['python3',ZONE+'/tools/host.py',operation,'--run',self.id])
        data=json.dumps(payload or {}).encode()
        if root:
            password=os.environ.get('RJD_SUDO_PASSWORD')
            if password:
                command="sudo -S -p '' "+command
                data=password.encode()+b'\n'+data
            else: command='sudo -n '+command
        return json.loads(self.ssh(command,data,timeout=1200 if operation=='analyze' else 300))

    def sync_tools(self):
        root=Path(__file__).resolve().parents[2]
        archive=io.BytesIO()
        with tarfile.open(fileobj=archive,mode='w:gz') as output:
            for file in Path(__file__).parent.iterdir():
                if file.suffix in ('.py','.cjs'):output.add(file,arcname='tools/'+file.name)
            for folder in ('testing/krsps-modbus','testing/can-server','message-gateway/proto'):
                for file in (root/folder).iterdir():
                    if file.suffix in ('.py','.proto'):output.add(file,arcname='fixtures/'+folder+'/'+file.name)
        self.ssh(shlex.join(['tar','xzf','-','-C',ZONE]),archive.getvalue())
        fingerprint=hashlib.sha256(b''.join(file.read_bytes() for file in sorted(Path(__file__).parent.iterdir()) if file.suffix in ('.py','.cjs'))).hexdigest()
        self.report.data['harness_sha256']=fingerprint

    def publish(self,artifacts=False):
        self.report.save()
        destination=PUBLISH+'/'+self.id
        self.ssh('mkdir -p '+shlex.quote(destination))
        published=getattr(self,'published_artifacts',set())
        names=[item['name'] for item in self.report.data['artifacts'] if artifacts or item['name'] not in published]+['report.json']
        for name in names:
            path=destination+'/'+name
            self.ssh('cat > '+shlex.quote(path+'.tmp')+' && mv '+shlex.quote(path+'.tmp')+' '+shlex.quote(path),
                     (self.report.root/name).read_bytes())
            if name!='report.json':published.add(name)
        self.published_artifacts=published
        self.last_publish=time.monotonic()

    def touch(self):
        while not self.heartbeat_stop.wait(15):
            try: self.ssh('touch '+shlex.quote(ZONE+'/runs/'+self.id+'/lease'),timeout=25)
            except Exception: pass

    def sample(self):
        value=self.rpc('sample')
        budget=storage_headroom(request('GET','/api/storage/pool',base=BASE+':8001',timeout=10),2*1024**3)
        value['cleaner_headroom_bytes']=budget['headroom_bytes']
        value.update(at=now(),phase=self.report.data['phase'])
        self.report.data['samples'].append(value)
        self.report.save()
        if not value.get('alive'): raise RuntimeError('Owned MC stopped unexpectedly')
        if value.get('free_bytes',0)<3*1024**3: raise RuntimeError('Less than 3 GiB remains on the recording filesystem')
        if value.get('available_mb',1000)<256:raise RuntimeError('Available board memory fell below 256 MiB')
        if value.get('temperature_c') is not None and value['temperature_c']>95:raise RuntimeError('Board temperature exceeded 95 C')
        if time.monotonic()-self.last_publish>20: self.publish()
        return value

    def wait(self,seconds,phase):
        self.report.data['phase']=phase
        deadline=time.monotonic()+max(0,seconds)
        while time.monotonic()<deadline:
            self.sample()
            self.report.data['progress']=min(98,round((time.monotonic()-self.report.started)/(self.minutes*60)*100,1))
            self.heartbeat_stop.wait(min(10,max(0,deadline-time.monotonic())))

    def ready(self):
        deadline=time.monotonic()+120
        while time.monotonic()<deadline:
            try:
                info=request('GET','/system/info',base=MC,timeout=10)
                if info.get('device_id'): return info
            except Exception: pass
            time.sleep(2)
        raise RuntimeError('Owned MC REST did not become ready')

    def transition(self,profile):
        for attempt in range(10):
            try:
                request('POST','/api/config/active',{'profile_id':profile})
                break
            except RuntimeError as error:
                if 'delivery is still in progress' not in str(error) or attempt==9:raise
                time.sleep(1)
        end=time.monotonic()+240
        while time.monotonic()<end:
            state=request('GET','/api/config/status').get('transition')
            if state and state['phase']=='complete': return state
            if state and state.get('error'): raise RuntimeError('Profile transition: '+state['error'])
            time.sleep(2)
        raise RuntimeError('Profile transition timed out')

    @contextmanager
    def pause(self,reason,expected_pause=True):
        event={'reason':reason,'expected_pause':expected_pause,'clock':'target','start_ms':round(time.time()*1000+self.clock_offset_ms)}
        self.report.data['events'].append(event)
        try: yield
        finally:
            event['end_ms']=round(time.time()*1000+self.clock_offset_ms)+2000
            self.report.save()

    def case(self,block,key,title,action):
        try:
            before=len(self.report.data['checks'])
            metrics=action()
            if metrics is None and len(self.report.data['checks'])>before:
                return self.report.data['checks'][-1]
            metrics=metrics or {}
            return self.report.check(block,key,title,'passed',metrics.pop('summary','Проверено'),**metrics)
        except Exception as error:
            return self.report.check(block,key,title,'failed',str(error))

    def source(self,kind,key,body=None):
        effective=request('GET','/api/config/effective')
        if effective['profile']['id']!=self.profile_id:raise RuntimeError('Active test profile changed externally')
        previous=effective['entities'].get(kind,{}).get(key,{}).get('body')
        before=request('GET','/config',base=MC).get('revision')
        result=request('DELETE' if body is None else 'PUT','/api/config/entities/'+kind+'/'+urllib.parse.quote(key,safe='')+'?'+urllib.parse.urlencode({'profile_id':self.profile_id}),body)
        if previous==body:return result
        deadline=time.monotonic()+150
        while time.monotonic()<deadline:
            state=next((item for item in request('GET','/api/config/status')['devices'] if item.get('device_id')==self.device),{})
            expected=state.get('expected')
            if expected and expected!=before and state.get('applied')==expected and state.get('state')=='ok':
                if request('GET','/config',base=MC).get('revision')==expected:return result
            time.sleep(1)
        raise RuntimeError('Source was saved but the board did not confirm the new revision')

    def setup(self):
        self.report.data['storage_guard']=storage_headroom(request('GET','/api/storage/pool',base=BASE+':8001',timeout=10),4*1024**3)
        self.publish()
        self.sync_tools()
        initialized=self.rpc('init',root=True)
        self.report.data['recording_directory']=initialized['recordings']
        self.report.data['binary_sha256']=initialized['binary_sha256']
        self.report.data['images']=initialized['images']
        self.heartbeat=threading.Thread(target=self.touch,daemon=True)
        self.heartbeat.start()
        self.rpc('start')
        info=self.ready()
        before=time.time()*1000
        clock=self.rpc('sample')
        after=time.time()*1000
        self.clock_offset_ms=clock['wall_ms']-(before+after)/2
        self.report.data['clock']={'target_offset_ms':round(self.clock_offset_ms),'uncertainty_ms':round((after-before)/2)}
        self.device=info['device_id']
        self.original=request('GET','/api/config/effective')
        self.original_id=(self.original.get('profile') or {}).get('id')
        if not self.original_id: raise RuntimeError('No active source profile')
        bodies=copy.deepcopy({kind:{key:entry['body'] for key,entry in values.items()} for kind,values in self.original['entities'].items()})
        bindings=bodies.get('binding',{})
        if any(binding.get('device_id')!=self.device for binding in bindings.values()):
            raise RuntimeError('Profile also binds other devices; refusing to stop boards outside .102')
        self.place=next(key for key,binding in bindings.items() if binding.get('device_id')==self.device)
        self.slot_state=[{k:v for k,v in body.items() if k!='place'} for body in bodies.get('neural_slot',{}).values() if body.get('place')==self.place]
        for camera in bodies.get('camera',{}).values():
            streams=camera.get('streams',{})
            preferred=next(iter(streams),None)
            neural=next((key for key,stream in streams.items() if 'neural' in stream.get('purposes',[])),None)
            if neural is None:neural=next((key for key,stream in streams.items() if 'birdview' not in stream.get('purposes',[])),None)
            for key,stream in streams.items():
                purposes=stream.get('purposes',[])
                if key==preferred:
                    purposes=[*purposes,'record']
                if key==neural:purposes=[*purposes,'neural']
                stream['purposes']=list(dict.fromkeys(purposes))
                if 'record' in stream.get('purposes',[]):
                    stream['segment_length']=10
                    stream['record_path']=initialized['recordings']
        for integration in bodies.get('integration',{}).values():
            for module in integration.get('modules',{}).values():module['enabled']=False
        document={'format':1,'profile':{'id':self.profile_id,'name':'Испытания '+self.id},'version':{'number':1},
                  'entities':[{'kind':kind,'key':key,'body':body} for kind,values in bodies.items() if kind!='binding' for key,body in values.items()], 'assets':{}}
        archive=io.BytesIO()
        with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as output: output.writestr('profile.json',json.dumps(document,ensure_ascii=False))
        boundary='rjd'+uuid.uuid4().hex
        payload=(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.varan"\r\nContent-Type: application/octet-stream\r\n\r\n').encode()+archive.getvalue()+f'\r\n--{boundary}--\r\n'.encode()
        request('POST','/api/config/load',payload,content_type='multipart/form-data; boundary='+boundary)
        self.clone_created=True
        for key,binding in bindings.items():
            request('PUT','/api/config/entities/binding/'+urllib.parse.quote(key,safe='')+'?profile_id='+self.profile_id,binding)
        self.profile_touched=True
        with self.pause('Выбор изолированного тестового профиля'): self.transition(self.profile_id)
        self.bodies=bodies
        self.report.check('neural','profile-switch','Полный переход на тестовый профиль','passed','Остановка, загрузка и запуск подтверждены',transition=request('GET','/api/config/status')['transition'])
        time.sleep(15)
        cameras=request('GET','/camera',base=MC).get('cameras') or {}
        self.recording_streams={(camera,key) for camera,body in cameras.items() for key,stream in body.get('streams',{}).items() if stream.get('status')==3 and 'record' in stream.get('purposes',[])}
        self.report.data['recording_streams']=[{'camera':camera,'stream':stream} for camera,stream in sorted(self.recording_streams)]
        self.neural_camera=next((camera for camera,body in cameras.items() if any(stream.get('status')==3 and 'neural' in stream.get('purposes',[]) for stream in body.get('streams',{}).values())),None)
        unavailable=[camera for camera,body in bodies.get('camera',{}).items() if camera not in cameras or not any(stream.get('status')==3 for stream in cameras[camera].get('streams',{}).values())]
        if unavailable:self.report.check('cameras','unavailable-inputs','Недоступные входы камер','blocked','Нет потока: '+', '.join(unavailable),cameras=unavailable)
        self.sample()

    def streams(self):
        data=request('GET','/camera',base=MC)
        cameras=data.get('cameras') or {}
        streams=[]
        for camera,body in cameras.items():
            for key,stream in (body.get('streams') or {}).items():
                purposes=stream.get('purposes') or []
                if 'view' in purposes and stream.get('status')==3:
                    streams.append({'camera':camera,'stream':key,'device':self.device})
        surround=None
        try:
            state=request('GET','/linker/status',base=MC)
            if state.get('stream_id'): surround={'camera':state['stream_id'],'device':self.device}
        except Exception: pass
        return streams,surround

    def mixed(self,seconds,key='webrtc-churn'):
        streams,surround=self.streams()
        if not streams: raise RuntimeError('No viewable source streams')
        config=self.report.root/(key+'-config.json')
        config.write_text(json.dumps({'base':BASE,'streams':streams,'surround':surround,'parallel':4}),encoding='utf-8')
        output=self.report.root/(key+'.jsonl')
        self.browser=subprocess.Popen(['node',str(Path(__file__).with_name('browser.cjs')),str(config),str(output),str(max(1,round(seconds)))],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        self.wait(seconds+1,'Смешанная нагрузка' if key=='webrtc-churn' else 'Повторная проверка потоков')
        code=self.browser.wait(timeout=45)
        self.browser=None
        rows=[json.loads(line) for line in output.read_text().splitlines() if line]
        cycles=[row for row in rows if row['event']=='cycle']
        ordinary=[row for row in cycles if not row['abrupt']]
        attempted=sum(len(row['ids']) for row in ordinary)
        rendered=sum(sum(any(item['id']==identity and item.get('width',0)>0 and item.get('time',0)>0 for batch in row['snapshots'] for item in batch) for identity in row['ids']) for row in ordinary)
        leaked=[row['cycle'] for row in cycles if row.get('remaining')]
        self.report.artifact(key+'.json','Сеансы WebRTC' if key=='webrtc-churn' else 'Повторные сеансы',rows)
        self.report.check('cameras',key,'Многократное открытие и закрытие потоков','passed' if code==0 and attempted and rendered==attempted and not leaked else 'failed',
                          f'Кадры получены в {rendered}/{attempted} сеансов',attempted=attempted,rendered=rendered,cycles=len(cycles),remaining=leaked,browser_exit=code)
        if surround:
            matches=[item for row in ordinary for batch in row['snapshots'] for item in batch if item['camera']==surround['camera'] and item.get('width',0)>0]
            self.report.check('surround',key+'-360','Получение живых кадров 360','passed' if matches else 'failed',f'Получено замеров с кадрами: {len(matches)}',samples=matches[-5:])

    def neural_load(self):
        if not self.slot_state:
            self.report.check('neural','neural-load','Применение слотов под нагрузкой','blocked','В исходном паспорте нет слотов')
            return
        if not self.neural_camera:
            self.report.check('neural','neural-input','Вход для нагрузки NPU','blocked','Нет доступного входа с назначением техзрения')
            return
        seed=self.slot_state[0]
        stream=self.bodies['video_stream'][seed['stream_id']]
        config=self.bodies['neural_config'][seed.get('config_id') or stream['config_id']]
        config_id='test_config_'+self.id[-6:]
        copied=copy.deepcopy(config)
        copied['id']=config_id
        copied['name']='Испытания '+self.id
        self.source('neural_config',config_id,copied)
        descs=[]
        for index in range(3):
            stream_id='test_stream_'+self.id[-6:]+'_'+str(index)
            body=copy.deepcopy(stream)
            body['id']=stream_id
            body['config_id']=config_id
            body['name']='Испытания '+str(index+1)
            for tile in body.get('tiles',[]):tile['camera']=self.neural_camera
            body['zones']={}
            self.source('video_stream',stream_id,body)
            descs.append({'stream_id':stream_id,'config_id':config_id,'depth':2,'fps':15})
        self.load_slots=descs
        self.set_slots(descs)
        return {'summary':'Применены три слота и новая конфигурация','slots':descs,'slot_status':request('GET','/neural/status',base=MC)}

    def set_slots(self,descs,require_running=True):
        request('POST','/api/neural/state?'+urllib.parse.urlencode({'device':self.device}),descs)
        time.sleep(10)
        actual=request('GET','/neural/status',base=MC)
        items=actual if isinstance(actual,list) else actual.get('slots',[])
        wanted={(item['stream_id'],item.get('config_id')) for item in descs}
        found={(item.get('stream_id'),item.get('config_id')) for item in items if item.get('running')}
        configured={(item.get('stream_id'),item.get('config_id')) for item in items}
        if configured!=wanted or require_running and not wanted.issubset(found): raise RuntimeError(f'Slots mismatch: expected {len(wanted)}, running {len(found)}')
        if require_running:
            deadline=time.monotonic()+30
            while any(item.get('fps',0)<=0 for item in items) and time.monotonic()<deadline:
                time.sleep(2)
                actual=request('GET','/neural/status',base=MC)
                items=actual if isinstance(actual,list) else actual.get('slots',[])
            if len(items)!=len(wanted) or any(not item.get('running') or item.get('fps',0)<=0 for item in items):
                raise RuntimeError('Configured neural slots did not produce inference frames')
        return {'summary':f'Применено слотов: {len(wanted)}, работают: {len(found)}','slot_status':actual}

    def surround(self):
        presets=self.bodies.get('preset',{})
        if not presets: raise RuntimeError('No source 360 presets')
        key,original=next(iter(presets.items()))
        before=self.rpc('surround')
        changed=copy.deepcopy(original)
        changed['name']=(changed.get('name') or key)+' test'
        self.source('preset',key,changed)
        after=self.rpc('surround')
        self.source('preset',key,original)
        if before!=after: raise RuntimeError('Preset rename changed derived map files')
        return {'summary':f'Переименование без пересчёта {len(before)} файлов','derived_files':len(before),'output':request('GET','/linker/status',base=MC)}

    def release_sources(self):
        if not hasattr(self,'load_slots'):return {'summary':'Тестовые источники не создавались'}
        for slot in self.load_slots:self.source('video_stream',slot['stream_id'])
        for key in sorted({slot['config_id'] for slot in self.load_slots}):self.source('neural_config',key)
        return {'summary':'Тестовые холсты и конфигурации удалены перед сравнением ресурсов'}

    def faults(self):
        def restart_mc():
            revision=request('GET','/config',base=MC).get('revision')
            surround_running=request('GET','/linker/status',base=MC).get('running')
            with self.pause('Перезапуск моей копии MC'):
                stopped=self.rpc('stop')
                if not stopped['stopped'] or stopped['forced']: raise RuntimeError('MC did not stop gracefully')
                self.rpc('start');self.ready();time.sleep(15)
            if request('GET','/config',base=MC).get('revision')!=revision:raise RuntimeError('MC restart did not preserve the applied revision')
            cameras=request('GET','/camera',base=MC).get('cameras',{})
            if any(cameras.get(camera,{}).get('streams',{}).get(stream,{}).get('status')!=3 for camera,stream in self.recording_streams):
                raise RuntimeError('Previously recording inputs did not recover after MC restart')
            if request('GET','/linker/status',base=MC).get('running')!=surround_running:raise RuntimeError('360 state did not recover after MC restart')
            return {'summary':'MC остановлен и запущен из своей применённой копии','revision':request('GET','/config',base=MC).get('revision')}
        self.case('recording','mc-restart','Запись после перезапуска MC',restart_mc)
        for service,base in (('message-gateway',BASE+':9090'),('detection-service',BASE+':8003')):
            def restart(service=service,base=base):
                before=request('GET','/runtime',base=base)
                with self.pause('Перезапуск '+service,expected_pause=False):
                    self.ssh(shlex.join(['docker','restart',service]))
                    deadline=time.monotonic()+60
                    while time.monotonic()<deadline:
                        try:
                            after=request('GET','/runtime',base=base,timeout=5)
                            if all(after.get(key)==before.get(key) for key in ('revision','transition_id','state')): break
                        except Exception: pass
                        time.sleep(2)
                    else: raise RuntimeError('Service did not restore its revision and transition')
                return {'summary':'Ревизия и переход сохранены после перезапуска','before':before,'after':after}
            self.case('can' if service=='message-gateway' else 'neural','restart-'+service,'Восстановление '+service,restart)
        checks=self.rpc('protocol',root=True)
        for check in checks:
            self.report.check(check['block'],check['id'],check['title'],check['status'],check['summary'],**check.get('metrics',{}))

    def recording(self):
        if not self.profile_touched:
            self.report.check('recording','recording-not-exercised','Проверка записи','blocked','Нагрузка не запускалась: подготовка тестового профиля не завершилась')
            return
        data=self.rpc('analyze',{'events':self.report.data['events']})
        self.report.artifact('segments.json','Сегменты и разрывы',data)
        rows=data['rows']
        invalid=[row for row in rows if not row.get('closed') or not row.get('exists') or not row.get('size') or not row.get('verified') or row.get('error')]
        self.report.check('recording','recording-files','Закрытие, читаемость и индекс всех сегментов',
                          'passed' if rows and not invalid and not data['unindexed_files'] and not data['mixed_into_original'] else 'failed',
                          f'Файлов {data["files"]}, в индексе {data["indexed"]}, проблемных {len(invalid)}',
                          files=data['files'],indexed=data['indexed'],invalid=invalid[:20],unindexed=data['unindexed_files'],mixed_into_original=data['mixed_into_original'])
        sessions={row['session_uid'] for row in rows}
        expected_sessions=1+sum(event['reason']=='Перезапуск моей копии MC' for event in self.report.data['events'])
        coverage={sid:sorted({(row['camera_id'],row['stream_key']) for row in rows if row['session_uid']==sid and row.get('verified')}) for sid in sessions}
        covered=bool(getattr(self,'recording_streams',None)) and len(sessions)==expected_sessions and all(self.recording_streams.issubset(set(values)) for values in coverage.values())
        self.report.check('recording','recording-coverage','Все доступные входы в каждой сессии MC','passed' if covered else 'failed',
                          f'Сессий {len(sessions)}/{expected_sessions}',coverage=coverage,expected_streams=self.report.data.get('recording_streams',[]))
        gaps=[gap for gap in data['gaps'] if not gap['expected']]
        holes=[{'file':row['file'],'holes_ms':row['holes_ms']} for row in rows if row.get('holes_ms')]
        self.report.check('recording','recording-continuity','Непрерывность по содержимому MP4',
                          'passed' if rows and not gaps and not holes else 'failed',f'Неожиданных границ: {len(gaps)}, файлов с паузами: {len(holes)}',
                          unexpected_gaps=gaps[:30],internal_holes=holes[:30],expected_gaps=[gap for gap in data['gaps'] if gap['expected']][:30])

    def cleanup(self):
        errors=[]
        if self.browser:
            try:
                self.browser.stdin.write(b'stop\n');self.browser.stdin.flush()
                self.browser.wait(70)
            except (BrokenPipeError,subprocess.TimeoutExpired):self.browser.kill()
        if self.original_id and self.profile_touched:
            try:
                if not self.rpc('sample').get('alive'):
                    self.rpc('start');self.ready()
                with self.pause('Возврат исходного профиля'): self.transition(self.original_id)
                restored=request('GET','/api/config/effective')
                same=restored['entities']==self.original['entities']
                self.report.data['cleanup']['restored']=same
                if not same:errors.append('Original source profile changed during the test')
            except Exception as error: errors.append('Restore: '+str(error))
        if self.clone_created and not errors:
            try:request('DELETE','/api/config/profiles/'+self.profile_id)
            except Exception as error:errors.append('Remove test profile: '+str(error))
        try:
            stopped=self.rpc('stop')
            self.report.data['cleanup']['mc_stopped']=stopped['stopped']
            if stopped['forced']:errors.append('MC required a forced stop')
        except Exception as error:errors.append('Stop: '+str(error))
        self.heartbeat_stop.set()
        if self.heartbeat:self.heartbeat.join(5)
        self.report.data['cleanup']['errors']=errors
        if errors:self.report.check('recording','cleanup','Завершение и восстановление','failed','; '.join(errors))

    def run(self):
        completed=False
        try:
            self.setup()
            seconds=self.minutes*60
            baseline=self.sample()
            self.wait(seconds/12,'Исходные замеры')
            baseline=self.sample()
            self.case('neural','neural-mixed-load','Слоты NPU для смешанной нагрузки',self.neural_load)
            self.case('cameras','camera-streams','Нагрузочный прогон потоков',lambda:self.mixed(seconds/2))
            start=time.monotonic()
            self.report.data['phase']='Слоты, конфигурации и 360'
            self.case('neural','neural-load-1','Новая конфигурация и первый цикл слотов',self.neural_load)
            self.wait(min(120,seconds/20),'Первый цикл слотов')
            if self.slot_state:self.case('neural','neural-restore-1','Снятие первого цикла нагрузки',lambda:self.set_slots(self.slot_state,False))
            self.wait(min(45,seconds/40),'Между циклами нагрузки')
            if hasattr(self,'load_slots'):
                self.case('neural','neural-load-2','Повторный цикл слотов',lambda:self.set_slots(self.load_slots))
                self.wait(min(120,seconds/20),'Повторный цикл слотов')
                self.case('neural','neural-restore-2','Возврат исходных слотов',lambda:self.set_slots(self.slot_state,False))
            self.case('neural','neural-source-release','Удаление тестовых источников',self.release_sources)
            self.case('surround','surround-apply','Применение пресета 360',self.surround)
            self.wait(max(0,seconds/4-(time.monotonic()-start)),'Наблюдение после применения конфигураций')
            after_load=self.sample()
            rss=after_load['rss_mb']-baseline['rss_mb'];fd=after_load['fd']-baseline['fd']
            self.report.check('neural','resource-retention','Ресурсы после снятия нагрузки','passed' if rss<=max(64,baseline['rss_mb']*.1) and fd<=8 else 'failed',
                              f'RSS {rss:+.1f} МБ, FD {fd:+d}',before=baseline,after=after_load,note='Замер до перезапуска MC; RSS сам по себе не доказывает утечку')
            start=time.monotonic()
            self.case('modbus','protocol-fixtures','Программные линии и восстановление сервисов',self.faults)
            self.case('cameras','recovery-streams','Потоки после перезапусков',lambda:self.mixed(90,'recovery-webrtc'))
            self.wait(max(0,seconds/12-(time.monotonic()-start)),'Восстановление после сбоев')
            self.wait(seconds/12,'Повторные замеры после снятия нагрузки')
            self.sample()
            completed=True
        except BaseException as error:
            self.report.data['state']='aborted'
            self.report.check('recording','run-aborted','Прогон прерван','failed',str(error) or type(error).__name__)
        finally:
            self.report.data['phase']='Завершение и сверка записи'
            self.cleanup()
            self.publish(artifacts=True)
            self.case('recording','recording-analysis','Сверка записи после остановки',self.recording)
            try:self.report.artifact('mc-log.txt','Журнал MC',self.rpc('logs')['text'])
            except Exception as error:self.report.check('recording','mc-log','Сохранение журнала','blocked',str(error))
            self.report.data['state']='completed' if completed else 'aborted'
            self.report.data.update(finished_at=now(),progress=100,phase='Завершён' if completed else 'Прерван')
            for block in ('cameras','neural','surround','can','modbus'):
                if not any(item['block']==block for item in self.report.data['checks']):
                    self.report.check(block,block+'-not-run','Проверки блока','blocked','Не выполнено из-за прерывания прогона')
            self.publish(artifacts=True)
        return 1 if any(item['status']=='failed' for item in self.report.data['checks']) else 0


def main():
    parser=argparse.ArgumentParser(description='Explicit whole-system test run on the owned .102 MC zone')
    parser.add_argument('--run',action='store_true',help='Explicitly execute the heavy test suite')
    parser.add_argument('--minutes',type=float,default=60)
    parser.add_argument('--results',type=Path,default=Path(os.environ.get('LOCALAPPDATA','/tmp'))/'Temp/codex-rjd-system-runs')
    args=parser.parse_args()
    if not args.run:parser.error('Heavy tests require the explicit --run flag')
    if not 1<=args.minutes<=1440:parser.error('Duration must be between 1 and 1440 minutes')
    suite=Suite(args)
    print('Run ID: '+suite.id,flush=True)
    raise SystemExit(suite.run())


if __name__=='__main__':main()
