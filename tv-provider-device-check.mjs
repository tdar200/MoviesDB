// Opt-in: takes control of the configured TV app. No media URLs/keys are saved.
import { writeFile } from 'node:fs/promises';
const inspector = process.argv[2];
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(inspector || '')) throw Error('Pass the helper’s loopback inspector URL');
const reportPath = process.argv[3] || '/tmp/movies-provider-device-results.json';
const targets = await (await fetch(inspector + '/json/list', {signal:AbortSignal.timeout(5000)})).json();
const target = targets.find(t => {try{return new URL(t.url).pathname === '/tv.html';}catch{return false;}});
if (!target) throw Error('Open the Movies app on the TV');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Inspector connection timed out')),8000);ws.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});ws.addEventListener('error',()=>{clearTimeout(timer);reject(Error('Inspector connection failed'));},{once:true});});
let next=0;const pending=new Map();
ws.addEventListener('message',e=>{const m=JSON.parse(e.data),job=pending.get(m.id);if(job){clearTimeout(job.timer);pending.delete(m.id);m.error?job.reject(Error(m.error.message)):job.resolve(m.result);}});
function call(method,params={}){return new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timed out'));},10000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression,contextId){const r=await call('Runtime.evaluate',{expression,contextId,userGesture:true,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);return r.result.value;}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,seconds=75){const end=Date.now()+seconds*1000;while(Date.now()<end){try{if(await fn())return true;}catch{}await sleep(2000);}return false;}
const origin=new URL(target.url).origin;let world, expectedPath;
async function frame(){const t=await call('Page.getFrameTree');const f=t.frameTree.childFrames?.find(x=>new URL(x.frame.url).hostname==='player.vidlove.cc'&&new URL(x.frame.url).pathname===expectedPath);if(!f)throw Error('111Movies frame absent');world=(await call('Page.createIsolatedWorld',{frameId:f.frame.id,worldName:'visible-playback-validation'})).executionContextId;}
async function state(){return evaluate(`(()=>{const v=document.querySelector('video');if(!v)return {ready:0,text:document.body.innerText.slice(0,150)};let visible=true;for(let e=v;e;e=e.parentElement){const s=getComputedStyle(e);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0)visible=false;}const r=v.getBoundingClientRect();return {time:v.currentTime,ready:v.readyState,paused:v.paused,muted:v.muted,error:v.error&&v.error.message,width:r.width,height:r.height,visible:visible&&r.width>=640&&r.height>=360&&r.right>0&&r.bottom>0&&r.left<innerWidth&&r.top<innerHeight,decodedWidth:v.videoWidth,decodedHeight:v.videoHeight,decodedFrames:v.webkitDecodedFrameCount,text:document.body.innerText.slice(0,120)}})()`,world);}
const key=(name,code)=>evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(name)},keyCode:${code},bubbles:true,cancelable:true}))`);
const click=id=>evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
const results=[];const save=()=>writeFile(reportPath,JSON.stringify(results,null,2));
const allTitles=[{name:'Project Hail Mary',id:687163},{name:'The Shawshank Redemption',id:278},{name:'The Matrix',id:603},{name:'Rick and Morty',id:60625,tv:true},{name:'Breaking Bad',id:1396,tv:true}];
const titles=process.env.TV_CHECK_TITLE ? allTitles.filter(t=>process.env.TV_CHECK_TITLE.split(',').includes(String(t.id))) : allTitles;
if(!titles.length)throw Error('Unknown TV_CHECK_TITLE');
try {
 await call('Page.navigate',{url:origin+'/tv.html'});
 if(!await until(()=>evaluate(`!!document.querySelector('.tv-card')`),45))throw Error('Catalogue failed');
 for(const title of titles){
  expectedPath=title.tv?`/embed/tv/${title.id}/1/1`:`/embed/movie/${title.id}`;
  const r={...title,checkedAt:new Date().toISOString()};results.push(r);console.log('TITLE',title.name);
  try {
   await evaluate(`document.getElementById('search').value=${JSON.stringify(title.name)};document.getElementById('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));`);
   if(!await until(()=>evaluate(`!!document.querySelector('.tv-card[data-movie-id="${title.id}"]')`),30))throw Error('Search failed');
   await evaluate(`var card=document.querySelector('.tv-card[data-movie-id="${title.id}"]');card.focus();card.click();`);
   if(title.tv){await until(()=>evaluate(`!!document.querySelector('#episode-select option[value="1"]')`),30);await evaluate(`var e=document.getElementById('episode-select');e.value='1';e.dispatchEvent(new Event('change',{bubbles:true}));`);}
   r.defaultSource=await evaluate(`document.getElementById('source-select').selectedOptions[0].textContent`);
   if(r.defaultSource!=='111Movies')throw Error('111Movies was not the default');
   let startupSample;
   r.started=await until(async()=>{await frame();const s=await state();const advancing=startupSample&&s.time>startupSample.time+1&&s.decodedFrames>startupSample.decodedFrames;startupSample=s;return advancing&&s.ready>=3&&s.visible;});
   if(!r.started)throw Error('No visible ready video');
   r.samples=[await state()];
   for(let i=0;i<6;i++){await sleep(10000);r.samples.push(await state());}
   r.continuous=r.samples.every((s,i)=>s.visible&&!s.error&&s.ready>=3&&!s.paused&&(i===0||s.time-r.samples[i-1].time>=8&&s.decodedFrames-r.samples[i-1].decodedFrames>=80));
   await evaluate(`document.getElementById('tv-provider-play').focus()`);
   await key('ArrowRight',39);r.remoteForwardFocus=await evaluate(`document.activeElement.id==='tv-provider-forward'`);
   await key('ArrowRight',39);r.remoteSoundFocus=await evaluate(`document.activeElement.id==='tv-provider-sound'`);
   await click('tv-provider-sound');await sleep(1200);r.unmuted=!(await state()).muted;
   r.focusAfterUnmute=await evaluate(`document.activeElement.id==='tv-provider-play'`);
   await key('MediaPause',19);const paused=await state();await sleep(2000);r.pause=paused.paused&&Math.abs((await state()).time-paused.time)<0.3;
   await key('MediaPlay',415);r.resume=await until(async()=>(await state()).time>paused.time+2,20);
   const before=(await state()).time;await click('tv-provider-forward');r.forward=await until(async()=>(await state()).time>before+25,20);
   const forward=(await state()).time;await click('tv-provider-backward');await sleep(500);r.backward=(await state()).time<forward-7;
   const seek=(await state()).time;await sleep(6000);r.afterSeekState=await state();r.afterSeekAdvances=r.afterSeekState.time>seek+3;
   await click('player-fullscreen');await sleep(1200);r.fullscreen=await evaluate(`!!document.fullscreenElement`);r.fullscreenState=await state();
   await evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'GoBack',keyCode:461,bubbles:true,cancelable:true}))`,world);await sleep(800);
   r.frameBackExitsFullscreen=await evaluate(`!document.fullscreenElement&&document.getElementById('player-modal').style.display!=='none'`);
   if(title.tv){expectedPath=`/embed/tv/${title.id}/1/2`;await click('next-episode');let previous; r.nextEpisode=await until(async()=>{await frame();const s=await state();const advancing=previous&&s.time>previous.time+1&&s.decodedFrames>previous.decodedFrames;previous=s;return advancing&&s.visible&&s.ready>=3&&await evaluate(`document.getElementById('player-title').textContent.includes('S1E2')`);});r.nextPath=expectedPath;r.nextState=await state();}
   await key('GoBack',461);r.back=await evaluate(`document.getElementById('player-modal').style.display==='none'`);r.focus=await until(()=>evaluate(`document.activeElement.dataset.movieId==='${title.id}'`),5);r.focusElement=await evaluate(`({id:document.activeElement.id,movieId:document.activeElement.dataset.movieId})`);
   const checks=['started','continuous','remoteForwardFocus','remoteSoundFocus','unmuted','focusAfterUnmute','pause','resume','forward','backward','afterSeekAdvances','fullscreen','frameBackExitsFullscreen','back','focus'];if(title.tv)checks.push('nextEpisode');
   r.failures=checks.filter(k=>r[k]!==true);if(!r.fullscreenState.visible)r.failures.push('fullscreenVisible');r.pass=r.failures.length===0;
  }catch(error){r.error=error.message;r.pass=false;await click('close-modal').catch(()=>{});}
  console.log('RESULT',JSON.stringify(r));await save();
 }
} finally {await save();await call('Page.navigate',{url:origin+'/tv.html'}).catch(()=>{});ws.close();for(const j of pending.values())clearTimeout(j.timer);}
process.exit(results.length===titles.length&&results.every(r=>r.pass)?0:1);
