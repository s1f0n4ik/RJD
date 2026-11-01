import json
import subprocess
import sys
import tempfile
from pathlib import Path

from recording import boundary_gaps, packet_span
from report import Report, sanitized
from run import storage_headroom

pool={'target':{'volume_id':'internal'},'summary':{'journal_bytes':0,'journal_reserve_bytes':0},'volumes':[{'id':'internal','internal':True,'state':'online','total_bytes':100*1024**3,'used_bytes':85*1024**3,'high':90}]}
assert storage_headroom(pool,4*1024**3)['headroom_bytes']==5*1024**3
for value in [{},dict(pool,target={'volume_id':'external'}),dict(pool,summary={}),dict(pool,summary={'journal_bytes':0,'journal_reserve_bytes':3*1024**3}),dict(pool,volumes=[pool['volumes'][0]|{'used_bytes':89*1024**3}])]:
    try:storage_headroom(value,4*1024**3)
    except RuntimeError:pass
    else:raise AssertionError('Unsafe cleaner budget was accepted')

span=packet_span([{'pts_time':-.08},{'pts_time':-.04},{'pts_time':0},{'pts_time':.04}])
assert span['content_ms']==160 and span['first_pts']==-.08
span=packet_span([{'pts_time':0,'duration_time':10},{'pts_time':.04},{'pts_time':4},{'pts_time':4.04}])
assert span['holes_ms']==[3960] and span['content_ms']<5000
row={'session_uid':'one','camera_id':'camera','stream_key':'stream-a','mono_start_ms':0,'wall_start_ms':100000,
     'content_ms':1000,'cadence_ms':40,'closed':True,'verified':True,'file':'a.mp4','holes_ms':[]}
following={**row,'mono_start_ms':2000,'wall_start_ms':102000,'file':'b.mp4'}
other={**row,'session_uid':'two','file':'c.mp4'}
other_stream={**row,'stream_key':'stream-b','mono_start_ms':5000,'file':'d.mp4'}
gaps=boundary_gaps([row,following,other,other_stream],[])
assert len(gaps)==1 and gaps[0]['gap_ms']==1000 and not gaps[0]['expected']
assert boundary_gaps([row|{'closed':False},following],[])[0]['gap_ms']==1000
assert not boundary_gaps([row,row|{'verified':False,'mono_start_ms':1000},following],[])
assert not boundary_gaps([row,following],[{'start_ms':101000,'end_ms':102000,'reason':'gateway restart','expected_pause':False}])[0]['expected']
gaps=boundary_gaps([row,following],[{'start_ms':101000,'end_ms':102000,'reason':'restart','expected_pause':True}])
assert gaps[0]['expected'] and gaps[0]['reasons']==['restart']
assert sanitized({'password':'secret','url':'rtsp://user:secret@host/live'})=={'password':'[redacted]','url':'rtsp://[redacted]@host/live'}
with tempfile.TemporaryDirectory() as directory:
    report=Report(Path(directory),'run-check','fixture')
    report.check('recording','once','First attempt','failed','Retain the failure')
    try:report.check('recording','once','Second attempt','passed','Do not overwrite')
    except ValueError:pass
    else:raise AssertionError('Earlier failure was overwritten')
    stored=json.loads((report.root/'report.json').read_text())
    assert stored['checks'][0]['status']=='failed'
result=subprocess.run([sys.executable,str(Path(__file__).with_name('run.py')),'--help'],capture_output=True)
assert result.returncode==0 and b'--run' in result.stdout
print('system-checks: OK')
