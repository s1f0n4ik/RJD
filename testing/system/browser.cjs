const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

(async()=>{
    const config=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
    const output=process.argv[3];
    const seconds=Number(process.argv[4]);
    if(!config.streams.length||!Number.isFinite(seconds)||seconds<=0)throw Error('Explicit streams and duration are required');
    const profile=await fs.mkdtemp(path.join(os.tmpdir(),'rjd-stream-test-'));
    const binary=process.env.CHROME_BIN||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'google-chrome');
    const child=spawn(binary,['--headless=new','--remote-debugging-port=0','--user-data-dir='+profile,
        '--no-first-run','--disable-background-networking','--disable-component-update','--disable-sync',
        '--autoplay-policy=no-user-gesture-required','--disable-background-timer-throttling',
        '--disable-renderer-backgrounding','--window-size=1440,1000','about:blank'],{windowsHide:true,stdio:'ignore'});
    let socket,send,evaluate;
    let stopping=false;
    process.stdin.on('data',()=>{stopping=true;});
    process.stdin.on('end',()=>{stopping=true;});
    const write=async value=>fs.appendFile(output,JSON.stringify({at:new Date().toISOString(),...value})+'\n');
    try{
        let active;
        for(let i=0;i<150;i++){try{active=await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8');break;}catch{await delay(100);}}
        if(!active)throw Error('Headless Chrome did not start');
        const tabs=await(await fetch('http://127.0.0.1:'+active.split('\n')[0]+'/json/list')).json();
        socket=new WebSocket(tabs.find(x=>x.type==='page').webSocketDebuggerUrl);
        await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
        const pending=new Map();let sequence=0;
        socket.addEventListener('message',event=>{
            const message=JSON.parse(event.data);
            if(message.id){const callbacks=pending.get(message.id);pending.delete(message.id);if(message.error)callbacks?.reject(message.error);else callbacks?.resolve(message.result);}
        });
        send=(method,params={})=>new Promise((resolve,reject)=>{
            const id=++sequence;
            const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method));},30000);
            pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
            socket.send(JSON.stringify({id,method,params}));
        });
        evaluate=async expression=>{
            const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
            if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));
            return result.result.value;
        };
        await send('Page.enable');await send('Runtime.enable');
        await send('Page.navigate',{url:config.base+'/tests/client.html'});
        const ready=async()=>{
            for(let i=0;i<100;i++){if(await evaluate('!!window.testRig'))return;await delay(100);}
            throw Error('Test client did not become ready');
        };
        await ready();
        const end=Date.now()+seconds*1000;
        let cycle=0;
        while(!stopping&&Date.now()<end){
            const abrupt=cycle%6===5;
            const exposure=abrupt?1800:15000;
            if(Date.now()+exposure>end)break;
            const stream=config.streams[cycle%config.streams.length];
            const streams=Array.from({length:config.parallel||4},(_,i)=>i===3&&config.surround?config.surround:stream);
            const ids=await evaluate(`window.testRig.open(${JSON.stringify(streams)})`);
            const snapshots=[];
            const waitUntil=Date.now()+exposure;
            while(!stopping&&Date.now()<waitUntil){await delay(1000);snapshots.push(await evaluate('window.testRig.snapshot()'));}
            if(abrupt){await send('Page.reload');await ready();}
            else await evaluate('window.testRig.close()');
            await delay(2000);
            const remaining=await evaluate('window.testRig.snapshot().length');
            await write({event:'cycle',cycle,stream,ids,abrupt,snapshots,remaining});
            cycle++;
        }
        await evaluate('window.testRig.close()');
        await write({event:'complete',cycles:cycle,cancelled:stopping});
    }catch(error){await write({event:'error',error:String(error)});process.exitCode=1;}
    finally{
        if(evaluate)await evaluate('window.testRig.close()').catch(()=>{});
        if(send)await send('Browser.close').catch(()=>{});
        if(socket)socket.close();
        if(child.exitCode===null)child.kill();
        process.stdin.destroy();
    }
})().catch(error=>{console.error(error);process.exitCode=1;});
