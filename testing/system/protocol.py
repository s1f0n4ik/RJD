import hashlib
import importlib.util
import json
import os
import socket
import struct
import subprocess
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ZONE=Path('/home/orangepi/media-center/codex')


def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def free_port():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1',0))
        return listener.getsockname()[1]


def run(run_id):
    fixture=ZONE/'fixtures'
    mb=load('mbstand',fixture/'testing/krsps-modbus/stand.py')
    codec=load('can_codec',fixture/'testing/can-server/codec.py')
    rest_port,grpc_port,stub_port=free_port(),free_port(),free_port()
    mb.GRPC_PORT=grpc_port
    name='rjd-test-'+hashlib.sha256(run_id.encode()).hexdigest()[:12]
    interface='rjdt'+hashlib.sha256(run_id.encode()).hexdigest()[:8]
    work=ZONE/'runs'/run_id/'protocol'
    work.mkdir(exist_ok=False)
    checks=[]
    created=False
    can_created=False
    can_ready=False
    can_sequence=0
    bus=mb.Bus()
    master=mb.Master(bus)
    stub=mb.Stub(stub_port)
    sender=None
    token=''
    package=None
    def check(block,key,title,fn):
        try:
            detail=fn()
            checks.append({'block':block,'id':key,'title':title,'status':'passed','summary':'Проверено на виртуальной линии','metrics':detail or {}})
        except Exception as error:
            checks.append({'block':block,'id':key,'title':title,'status':'failed','summary':str(error),'metrics':{}})
    def require(condition,message):
        if not condition: raise AssertionError(message)
    def request(method,path,body=None):
        data=None if body is None else json.dumps(body).encode()
        req=urllib.request.Request(f'http://127.0.0.1:{rest_port}'+path,data=data,method=method,headers={'Content-Type':'application/json'})
        with urllib.request.urlopen(req,timeout=15) as response:
            value=json.load(response)
        return value.get('data',value)
    def module(): return request('GET','/status')['modules'][0]
    def wait_health():
        end=time.monotonic()+25
        while time.monotonic()<end:
            try:
                if request('GET','/health')['status']=='ok': return
            except Exception: time.sleep(.25)
        raise RuntimeError('Fixture gateway did not become healthy')
    def configure(active,settings):
        nonlocal token,package
        current=request('GET','/runtime')
        token='test-'+str(time.time_ns())
        request('PUT','/runtime',{'action':'stop','transition_id':token,'previous_transition_id':current['transition_id']})
        package={'transition_id':token,'revision':token,'active':active,'integrations':{
            'rsm-2000':{'modules':{'websocket':{'enabled':False},'can':{'enabled':False}}},
            'iskra':{'modules':{'modbus':{'enabled':False}}}}}
        package['integrations'][active]['modules'].update(settings)
        request('PUT','/config',package)
        request('PUT','/runtime',{'action':'start','transition_id':token,'revision':token})
    try:
        for candidate in (name,name+'-sender'):
            probe=subprocess.run(['docker','inspect',candidate],capture_output=True)
            if probe.returncode==0: raise RuntimeError('Refusing to replace an existing fixture container')
        image=subprocess.check_output(['docker','inspect','-f','{{.Image}}','message-gateway']).decode().strip()
        subprocess.run(['docker','run','-d','--name',name,'--network','host','--cap-drop','SYS_TIME',
                        '--user',f'{os.getuid()}:{os.getgid()}','-v','/dev/pts:/dev/pts','-v',f'{work}:/data',image,
                        '--rest-port',str(rest_port),'--grpc-port',str(grpc_port),'--state-file','/data/gateway-state.json',
                        '--backend-url',f'http://127.0.0.1:{stub_port}','--can-enabled','0','--ws-host','127.0.0.1','--ws-port','9'],check=True,capture_output=True)
        created=True
        wait_health()
        configure('iskra',{'modbus':{'enabled':True,'device':bus.path,'slave':20}})
        detection_image=subprocess.check_output(['docker','inspect','-f','{{.Image}}','detection-service']).decode().strip()
        sender=mb.Sender(detection_image,name+'-sender')
        def basic():
            result=master.read(0x1000,8)
            require(isinstance(result,list) and result[:6]==[20,1,32,0x1000,3,1],repr(result))
            return {'registers':result}
        check('modbus','modbus-registers','Регистры и CRC ответов',basic)
        def invalid():
            cases=[(0x1000,1,3,1),(0x1000,0,4,3),(0x1000,126,4,3),(0x0fff,2,4,2),(0x2fff,2,4,2)]
            for register,count,fc,code in cases: require(master.read(register,count,fc=fc)==mb.Exc(code),'Wrong Modbus exception')
            frame=bytearray(mb.adu(20,struct.pack('>BHH',4,0x1000,2)))
            frame[-1]^=255
            bus.drain();bus.write(frame)
            require(bus.quiet()==b'','Bad CRC received an answer')
            require(master.read(0x1000,2)==[20,1],'Parser did not recover after bad CRC')
            require(master.silent(struct.pack('>BHH',4,0x1000,2),addr=21)==b'','Foreign address received an answer')
            return {'exceptions':len(cases),'bad_crc_silent':True,'foreign_address_silent':True}
        check('modbus','modbus-invalid','Ошибки протокола и восстановление',invalid)
        def queue():
            master.write_time_gps(int(time.time()))
            for number in range(1,4):
                reply=sender.send({'code':1,'frame_id':number,'camera_mask':1,'zone':3,'count':1},id=number,runtime_id=token,modules=['modbus'])
                require(reply['accepted'],repr(reply))
            end=time.monotonic()+5
            records=[]
            while time.monotonic()<end:
                records=master.records(3)
                if len(records)==3: break
                time.sleep(.1)
            require([item['frame_id'] for item in records]==[1,2,3],repr(records))
            before=module()['queue']['total']
            require(not sender.send({'code':1},runtime_id='obsolete',modules=['modbus'])['accepted'],'Obsolete runtime admitted')
            master.mark(100,101)
            require(module()['queue']['total']==before,'Invalid ACK removed accepted records')
            subprocess.run(['docker','restart',name],check=True,capture_output=True)
            wait_health()
            after_restart=module()['queue']['total']
            require(after_restart==before,'Queue did not survive restart')
            master.mark(records[0]['number'],records[-1]['number'])
            require(module()['queue']['total']==0,'Valid ACK did not remove accepted records')
            return {'records':records,'before_restart':before,'after_restart':after_restart,'after_ack':module()['queue']['total'],'stale_token_rejected':True}
        check('modbus','modbus-queue','Очередь, подтверждения и перезапуск',queue)
        def reconnect():
            nonlocal bus,master
            bus.close()
            bus=mb.Bus();master=mb.Master(bus)
            configure('iskra',{'modbus':{'enabled':True,'device':bus.path,'slave':20}})
            require(master.read(0x1000,2)==[20,1],'Virtual serial reconnect failed')
            return {'reconnected':True}
        check('modbus','modbus-reconnect','Обрыв и повторное открытие порта',reconnect)
        try:
            subprocess.run(['modprobe','vcan'],check=True,capture_output=True)
            subprocess.run(['ip','link','add','dev',interface,'type','vcan'],check=True,capture_output=True)
            can_created=True
            subprocess.run(['ip','link','set',interface,'up'],check=True,capture_output=True)
            can_ready=True
        except (subprocess.CalledProcessError,OSError) as error:
            checks.append({'block':'can','id':'can-interface','title':'Виртуальная CAN-линия','status':'blocked',
                           'summary':'Ядро не предоставило vcan','metrics':{'error':str(error) if isinstance(error,OSError) else error.stderr.decode(errors='replace')[-1000:]}})
        if can_ready:
            configure('rsm-2000',{'can':{'enabled':True,'mode':'socketcan','iface':interface,'tx_period_ms':100,
                                      'tx_continuous':True,'payload_ttl_enabled':False}})
            with socket.socket(socket.PF_CAN,socket.SOCK_RAW,socket.CAN_RAW) as can:
                can.bind((interface,));can.settimeout(1)
                frame=struct.Struct('=IB3x8s')
                def can_payload(receiver=can):
                    nonlocal can_sequence
                    can_sequence+=1
                    reply=sender.send(runtime_id=token,id=100+can_sequence,event='CONFIRMED',camera_no=2,modules=['can'],
                                      dets=[{'detection_id':42+can_sequence,'cid':0,'cls':'person','type':1,'danger':3}])
                    require(reply['accepted'],repr(reply))
                    end=time.monotonic()+5
                    while time.monotonic()<end:
                        raw=receiver.recv(frame.size);can_id,dlc,data=frame.unpack(raw)
                        if data[:4]==bytes([1,1,3,2]):
                            require(can_id&0x80000000 and (can_id&0x1fffffff)==codec.DETECTION_ID,'Unexpected CAN identifier')
                            require(dlc==8 and data[4:]==b'\xff'*4,'Unexpected CAN padding/DLC')
                            return {'id':hex(can_id&0x1fffffff),'dlc':dlc,'payload':data.hex()}
                    raise AssertionError('Expected CAN payload was not received')
                check('can','can-payload','Идентификатор, DLC и полезная нагрузка CAN',can_payload)
                def receive():
                    can.send(frame.pack(codec.GPS_ID|0x80000000,8,codec.encode_gps(55.752057,37.626105)))
                    can.send(frame.pack(codec.TIME_ID|0x80000000,8,codec.encode_time(datetime.now(timezone.utc),1)))
                    time.sleep(.4)
                    value=request('GET','/time')
                    require('55.75' in json.dumps(value),'Gateway did not receive CAN GPS')
                    return value
                check('can','can-receive','Приём времени и координат по CAN',receive)
                def reconnect_can():
                    subprocess.run(['ip','link','set',interface,'down'],check=True,capture_output=True)
                    time.sleep(.5)
                    subprocess.run(['ip','link','set',interface,'up'],check=True,capture_output=True)
                    configure('rsm-2000',{'can':{'enabled':True,'mode':'socketcan','iface':interface,'tx_period_ms':100,'tx_continuous':True,'payload_ttl_enabled':False}})
                    with socket.socket(socket.PF_CAN,socket.SOCK_RAW,socket.CAN_RAW) as receiver:
                        receiver.bind((interface,));receiver.settimeout(1)
                        return can_payload(receiver)
                check('can','can-reconnect','Восстановление виртуальной CAN-линии',reconnect_can)
        return checks
    finally:
        if sender:
            try: sender.close()
            except Exception: pass
        if created:
            subprocess.run(['docker','rm','-f',name,name+'-sender'],capture_output=True)
        if can_created:
            subprocess.run(['ip','link','delete',interface],capture_output=True)
        bus.close()
        stub.close()
        stub.http.server_close() if hasattr(stub,'http') else None
