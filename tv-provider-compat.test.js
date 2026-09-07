import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { compatibilityScript } from './tv-provider-compat.mjs';
test('compatibility shim guards old MediaSession and accepts controls only from the app parent',async()=>{
 const events={};const messages=[];let played=0,paused=0;
 const video={currentTime:40,duration:100,paused:true,muted:true,volume:0,readyState:4,play(){played++;return Promise.resolve();},pause(){paused++;}};
 const parent={postMessage:(data,origin)=>messages.push({data,origin})};
 const context={navigator:{mediaSession:{}},parent,document:{querySelector:()=>video},window:{moviesCompat:{parentOrigin:'https://app.example'},addEventListener:(type,fn)=>events[type]=fn},setInterval:fn=>fn()};
 vm.runInNewContext(await readFile(new URL('./tv-provider-bridge.js',import.meta.url),'utf8'),context);
 assert.equal(typeof context.navigator.mediaSession.setPositionState,'function');
 const send=(origin,source,command)=>events.message({origin,source,data:{moviesProviderCommand:command}});
 send('https://evil.example',parent,'play');send('https://app.example',{},'play');assert.equal(played,0);
 send('https://app.example',parent,'play');assert.equal(played,1);
 send('https://app.example',parent,'pause');assert.equal(paused,1);
 send('https://app.example',parent,'forward');assert.equal(video.currentTime,70);
 send('https://app.example',parent,'unmute');assert.equal(video.muted,false);
 assert.equal(messages[0].origin,'https://app.example');
});


test('preload is restricted to the original provider and preserves modern MediaSession', async()=>{
 const bridge=await readFile(new URL('./tv-provider-bridge.js',import.meta.url),'utf8');
 const source=compatibilityScript(bridge,'https://app.example');
 const untouched={location:{hostname:'unrelated.example'},window:{}};
 vm.runInNewContext(source,untouched);assert.equal(untouched.window.moviesCompat,undefined);
 const method=()=>42;const context={location:{hostname:'player.vidlove.cc'},navigator:{mediaSession:{setPositionState:method}},window:{addEventListener(){}},parent:{postMessage(){}},document:{querySelector:()=>null},setInterval(){}};
 vm.runInNewContext(source,context);assert.equal(context.navigator.mediaSession.setPositionState,method);
 assert.equal(context.window.moviesCompat.parentOrigin,'https://app.example');
});

test('inspection preload forces the CLI forwarder onto loopback',async()=>{
 const preload=new URL('./tv-inspect-loopback.mjs',import.meta.url).href;
 const result=await promisify(execFile)(process.execPath,['--import',preload,'--input-type=module','-e',"import net from 'node:net';const s=net.createServer();s.listen(0,null,()=>{console.log(s.address().address);s.close();});"]);
 assert.equal(result.stdout.trim(),'127.0.0.1');
});

test('frozen ready playback is restarted, but user pause and buffering are respected',async()=>{
 let tick,starts=0,pauses=0;
 const v={currentTime:100,readyState:4,paused:false,muted:true,duration:200,play(){starts++;this.paused=false;return Promise.resolve();},pause(){pauses++;this.paused=true;}};
 const context={navigator:{mediaSession:{}},window:{moviesCompat:{parentOrigin:'https://app.example'},addEventListener(){}},parent:{postMessage(){}},document:{querySelector:()=>v},setInterval:fn=>tick=fn};
 vm.runInNewContext(await readFile(new URL('./tv-provider-bridge.js',import.meta.url),'utf8'),context);
 for(let i=0;i<9;i++)tick();assert.equal(starts,1);assert.equal(pauses,1);
 for(let i=0;i<30;i++)tick();assert.equal(starts,2,'cap retries for a persistently frozen source');
 v.currentTime=110;tick();v.paused=true;
 for(let i=0;i<12;i++)tick();assert.equal(starts,2,'never resume an intentional pause');
 v.paused=false;v.readyState=2;
 for(let i=0;i<12;i++)tick();assert.equal(starts,2,'do not interrupt buffering');
 v.readyState=4;v.seeking=true;
 for(let i=0;i<12;i++)tick();assert.equal(starts,2,'do not interrupt a seek');
 v.seeking=false;context.document.hidden=true;
 for(let i=0;i<12;i++)tick();assert.equal(starts,2,'do not restart a background app');
});

test('server exhaustion and prolonged buffering report failure once with the resume position',async()=>{
 let tick;const messages=[];
 const v={currentTime:3158,readyState:2,paused:false,muted:false,duration:8000};
 const context={navigator:{mediaSession:{}},window:{moviesCompat:{parentOrigin:'https://app.example'},addEventListener(){}},parent:{postMessage:m=>messages.push(m)},document:{body:{innerText:'All servers are currently unavailable. No backup servers available'},querySelector:()=>v},setInterval:fn=>tick=fn};
 const source=await readFile(new URL('./tv-provider-bridge.js',import.meta.url),'utf8');
 vm.runInNewContext(source,context);tick();tick();
 const failures=messages.filter(m=>m.type==='failure');assert.equal(failures.length,1);assert.equal(failures[0].detail.reason,'servers-unavailable');assert.equal(failures[0].detail.time,3158);
 delete context.window.moviesProviderBridgeInstalled;context.document.body.innerText='BUFFERING';messages.length=0;
 vm.runInNewContext(source,context);
 for(let i=0;i<31;i++)tick();assert.equal(messages.filter(m=>m.type==='failure').length,1);assert.equal(messages.find(m=>m.type==='failure').detail.reason,'stalled');
});

test('terminal provider errors recover even when the failed video is paused', async()=>{
 let tick;const messages=[];
 const video={currentTime:0,readyState:1,paused:true,muted:true,duration:0};
 const context={navigator:{},window:{moviesCompat:{parentOrigin:'https://app.example'},addEventListener(){}},parent:{postMessage:data=>messages.push(data)},document:{body:{innerText:'All servers are currently unavailable'},querySelector:()=>video},setInterval:fn=>tick=fn};
 vm.runInNewContext(await readFile(new URL('./tv-provider-bridge.js',import.meta.url),'utf8'),context);
 tick();tick();
 assert.equal(messages.filter(m=>m.type==='failure').length,1);
 assert.equal(messages.find(m=>m.type==='failure').detail.reason,'servers-unavailable');
});
