import { parseByteRange } from './http-range.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('TV native player fills the screen, hides controls, seeks, pauses, and returns from options', { skip: !process.env.TV_E2E, timeout: 60000 }, async () => {
 const dir = await mkdtemp(join(tmpdir(),'movies-player-test-'));
 const browser = await chromium.launch({ executablePath:process.env.CHROME_PATH || '/usr/bin/google-chrome',headless:true,args:['--no-sandbox'] });
 try {
  const file = join(dir,'test.mp4');
  await promisify(execFile)('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=25','-f','lavfi','-i','sine=frequency=440','-t','60','-c:v','libx264','-preset','ultrafast','-g','50','-c:a','aac','-movflags','+faststart','-y',file]);
  const bytes=await readFile(file);
  const page = await browser.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:0.5});
  // Exercise progressive playback with a real MP4 fixture; native HLS is covered separately.
  await page.addInitScript(()=>{const original=HTMLMediaElement.prototype.canPlayType;HTMLMediaElement.prototype.canPlayType=function(type){return type.includes('mpegurl')?'':original.call(this,type);};});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const movie={id:9001,title:'Playback test',media_type:'movie',vote_average:9,vote_count:5000,release_date:'2024-01-01',genre_ids:[18]};
  await page.route('https://api.themoviedb.org/**',r=>r.fulfill({json:r.request().url().includes('external_ids')?{imdb_id:'tt1234567'}:{results:[movie],total_pages:1}}));
  await page.route('**/yts?*',r=>r.fulfill({json:{title:movie.title,torrents:[{hash:'a'.repeat(40),quality:'1080p',seeds:100,video_codec:'x264'}]}}));
  await page.route('**/subtitles?*',r=>r.fulfill({json:{tracks:[]}}));
  await page.route('**/stream-status?*',r=>r.fulfill({json:{state:'ready',peers:100}}));
  await page.route('**/stream-stop?*',r=>r.fulfill({status:204}));
  await page.route('**/stream?*',r=>{
    const range=parseByteRange(r.request().headers().range,bytes.length);
    return r.fulfill({status:range?206:200,contentType:'video/mp4',body:range?bytes.subarray(range.start,range.end+1):bytes,headers:{'access-control-allow-origin':'*','accept-ranges':'bytes',...(range?{'content-range':`bytes ${range.start}-${range.end}/${bytes.length}`}:{})}});
  });
  await page.goto(`${process.env.TV_TEST_URL || 'http://127.0.0.1:8123'}/tv.html?source=YTS%20(Torrent)`);
  await page.waitForSelector('.tv-card');
  await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
  await page.waitForFunction(()=>document.getElementById('player-video').currentTime>0.5);
  assert.equal(await page.locator(':focus').getAttribute('id'),'tv-play-pause');
  const rect = await page.locator('#player-video').boundingBox();
  assert.deepEqual(rect,{x:0,y:0,width:1920,height:1080});
  await page.screenshot({path:'/tmp/movies-player-controls.jpg',type:'jpeg',quality:70});
  await page.waitForFunction(()=>document.getElementById('player-modal').classList.contains('tv-hud-hidden'));
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#player-video').evaluate(v=>v.paused),true);
  await page.keyboard.press('Enter');
  await page.waitForFunction(()=>!document.getElementById('player-video').paused);
  await page.waitForFunction(()=>document.getElementById('player-modal').classList.contains('tv-hud-hidden'));
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(()=>document.getElementById('player-video').currentTime>30);
  await page.keyboard.press('ArrowDown');
  // Re-enter transport controls and reach Playback options using the D-pad.
  await page.locator('#tv-play-pause').focus();
  await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator(':focus').getAttribute('id'),'tv-player-settings');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#player-modal').evaluate(e=>e.classList.contains('tv-settings-open')),true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator(':focus').getAttribute('id'),'tv-player-settings');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#player-modal',{state:'hidden'});
  assert.equal(await page.locator(':focus').getAttribute('class'),'tv-play');
  assert.deepEqual(errors,[]);
 } finally {await browser.close();await rm(dir,{recursive:true,force:true});}
});

test('ending an episode autoplays the next one, discards stale lookup, and prefers 1080p on TV', {skip:!process.env.TV_E2E,timeout:30000},async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 try{
  const page=await browser.newPage({viewport:{width:1920,height:1080}});
  await page.addInitScript(()=>{const original=HTMLMediaElement.prototype.canPlayType;HTMLMediaElement.prototype.canPlayType=function(type){return type.includes('mpegurl')?'maybe':original.call(this,type);};});
  const series={id:9002,name:'Fixture Series',media_type:'tv',vote_average:9,vote_count:5000,first_air_date:'2024-01-01',genre_ids:[18]};
  await page.route('https://api.themoviedb.org/**',r=>{
   const url=r.request().url();let data={results:[series],total_pages:1};
   if(url.includes('/external_ids'))data={imdb_id:'tt1234567'};
   else if(url.includes('/season/'))data={episodes:[{episode_number:1,name:'First'},{episode_number:2,name:'Second'}]};
   else if(url.includes('/tv/9002?'))data={seasons:[{season_number:1,episode_count:2}]};
   return r.fulfill({json:data});
  });
  let releaseFirst;const firstGate=new Promise(r=>releaseFirst=r);let firstSeen;
  const firstRequest=new Promise(r=>firstSeen=r);
  const starts=[];
  await page.route('**/tv-torrents?*',async r=>{
   const episode=new URL(r.request().url()).searchParams.get('episode');
   if(episode==='1'){firstSeen();await firstGate;}
   await r.fulfill({json:{sources:[{hash:'c'.repeat(40),filename:'Fixture.Series.x264.mkv',title:'Fixture Series x264',quality:'1080p',remux:true,seeds:100},{hash:(episode==='1'?'a':'b').repeat(40),filename:`Fixture.Series.S01E0${episode}.x264.mkv`,title:'Fixture Series x264',quality:'720p',remux:true,seeds:100}]}});
  });
  await page.route('**/hls/start?*',r=>{starts.push(new URL(r.request().url()).searchParams.get('hash'));return r.fulfill({status:504,json:{error:'Test source unavailable'}});});
  await page.route('**/subtitles?*',r=>r.fulfill({json:{tracks:[]}}));
  await page.goto(`${process.env.TV_TEST_URL||'http://127.0.0.1:8123'}/tv.html?source=TV%20(Torrent)`);
  await page.waitForSelector('.tv-card');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
  await firstRequest;
  await page.waitForSelector('#tv-next',{state:'visible'});
  await page.locator('#player-video').evaluate(video=>video.dispatchEvent(new Event('ended')));
  await page.waitForFunction(()=>document.getElementById('player-title').textContent.includes('S1E2'));
  releaseFirst();
  await page.waitForTimeout(1200);
  assert.equal(starts[0],'c'.repeat(40), '1080p (default) attempted before 720p');
  assert.ok(!starts.includes('a'.repeat(40)), 'the stale first episode must never start');
 }finally{await browser.close();}
});

test('native HLS televisions prepare movie playback through HLS at 1080p', {skip:!process.env.TV_E2E,timeout:30000},async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 try{
  const page=await browser.newPage({viewport:{width:1920,height:1080}});
  await page.addInitScript(()=>{const original=HTMLMediaElement.prototype.canPlayType;HTMLMediaElement.prototype.canPlayType=function(type){return type.includes('mpegurl')?'maybe':original.call(this,type);};});
  const movie={id:9003,title:'HLS Movie',media_type:'movie',vote_average:9,vote_count:5000,release_date:'2024-01-01',genre_ids:[18]};
  await page.route('https://api.themoviedb.org/**',r=>r.fulfill({json:r.request().url().includes('external_ids')?{imdb_id:'tt1234567'}:{results:[movie],total_pages:1}}));
  await page.route('**/yts?*',r=>r.fulfill({json:{title:movie.title,torrents:[{hash:'a'.repeat(40),quality:'1080p',seeds:100,video_codec:'x264'},{hash:'b'.repeat(40),quality:'720p',seeds:100,video_codec:'x264'}]}}));
  const starts=[];
  await page.route('**/hls/start?*',r=>{starts.push(new URL(r.request().url()).searchParams.get('hash'));return r.fulfill({json:{id:'fixture'}});});
  await page.route('**/hls/fixture/index.m3u8*',r=>r.fulfill({contentType:'application/vnd.apple.mpegurl',body:'#EXTM3U\n#EXT-X-TARGETDURATION:4\n'}));
  await page.route('**/subtitles?*',r=>r.fulfill({json:{tracks:[]}}));
  await page.route('**/stream-status?*',r=>r.fulfill({json:{state:'ready',peers:100}}));
  await page.goto(`${process.env.TV_TEST_URL||'http://127.0.0.1:8123'}/tv.html?source=YTS%20(Torrent)`);
  await page.waitForSelector('.tv-card');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
  await page.waitForFunction(()=>document.getElementById('player-video').src.includes('/hls/fixture/index.m3u8'));
  assert.equal(starts[0],'a'.repeat(40), 'movie playback must begin with 1080p before any fixture-error fallback');
 }finally{await browser.close();}
});

test('overlapping subtitle lookups keep only the latest menu', {skip:!process.env.TV_E2E,timeout:30000},async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 try{
  const page=await browser.newPage({viewport:{width:1920,height:1080}});
  await page.addInitScript(()=>{const original=HTMLMediaElement.prototype.canPlayType;HTMLMediaElement.prototype.canPlayType=function(type){return type.includes('mpegurl')?'maybe':original.call(this,type);};});
  const movie={id:9004,title:'Subtitle race',media_type:'movie',vote_average:9,vote_count:5000,release_date:'2024-01-01',genre_ids:[18]};
  await page.route('https://api.themoviedb.org/**',r=>r.fulfill({json:r.request().url().includes('external_ids')?{imdb_id:'tt1234567'}:{results:[movie],total_pages:1}}));
  await page.route('**/yts?*',r=>r.fulfill({json:{title:movie.title,torrents:[{hash:'b'.repeat(40),quality:'720p',seeds:100,video_codec:'x264'}]}}));
  await page.route('**/hls/start?*',r=>r.fulfill({status:504,json:{error:'Fixture source unavailable'}}));
  let firstSeen,releaseFirst;const firstRequest=new Promise(r=>firstSeen=r),gate=new Promise(r=>releaseFirst=r);let calls=0;
  await page.route('**/subtitles?*',async r=>{const first=++calls===1;if(first){firstSeen();await gate;}await r.fulfill({json:{duration:60,tracks:[{id:'f1',label:first?'Spanish':'English',lang:first?'es':'en'}]}});});
  await page.route('**/subtitle?*',r=>r.fulfill({contentType:'text/vtt',body:'WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nCaption\n'}));
  await page.goto(`${process.env.TV_TEST_URL||'http://127.0.0.1:8123'}/tv.html?source=YTS%20(Torrent)`);
  await page.waitForSelector('.tv-card');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');await firstRequest;
  await page.locator('#quality-select').evaluate(el=>el.dispatchEvent(new Event('change',{bubbles:true})));
  await page.waitForFunction(()=>document.getElementById('subtitle-select').textContent.includes('English'));
  releaseFirst();await page.waitForTimeout(500);
  assert.deepEqual(await page.locator('#subtitle-select option').allTextContents(),['Subtitles: off','English']);
  assert.equal(await page.locator('#player-video track').count(),1);
 }finally{await browser.close();}
});

test('111Movies legacy layout fills the frame instead of playing at zero size', {skip:!process.env.TV_E2E,timeout:30000}, async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 try {
  const page=await browser.newPage({viewport:{width:1920,height:855}});
  // Model the provider's fixed root when an old browser ignores inset:0.
  await page.setContent('<style>body{margin:0}.fixed{position:fixed}.absolute{position:absolute}.w-full{width:100%}.h-full{height:100%}</style><div class="fixed inset-0"><div class="absolute inset-0 w-full h-full"><video class="absolute inset-0 w-full h-full"></video></div></div>');
  const rect=()=>page.locator('video').boundingBox();
  assert.deepEqual(await rect(),{x:0,y:0,width:0,height:0});
  await page.evaluate(()=>{window.CSS.supports=()=>false;window.moviesCompat={parentOrigin:location.origin};});
  const bridge=await readFile(new URL('./tv-provider-bridge.js',import.meta.url),'utf8');
  await page.evaluate(bridge);
  assert.deepEqual(await rect(),{x:0,y:0,width:1920,height:855});
  await page.setViewportSize({width:1920,height:1080});
  assert.deepEqual(await rect(),{x:0,y:0,width:1920,height:1080});
  await page.evaluate(bridge);
  assert.equal(await page.locator('#movies-provider-layout').count(),1);
 } finally {await browser.close();}
});

for (const kind of ['movie', 'tv', 'movie-alternate']) test(`111Movies fallback preserves the ${kind} position in the built-in HLS player`,{skip:!process.env.TV_E2E,timeout:30000},async()=>{
 const mediaType=kind==='tv'?'tv':'movie';
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 try{
  const page=await browser.newPage({viewport:{width:1920,height:1080}});
  await page.addInitScript(()=>{const original=HTMLMediaElement.prototype.canPlayType;HTMLMediaElement.prototype.canPlayType=function(t){return t.includes('mpegurl')?'maybe':original.call(this,t);};});
  const movie={id:9006,title:'Provider fallback',media_type:mediaType,name:'Provider fallback',first_air_date:'2024-01-01',vote_average:9,vote_count:5000,release_date:'2024-01-01',genre_ids:[18]};
  await page.route('https://api.themoviedb.org/**',r=>{const u=r.request().url();let json={results:[movie],total_pages:1};if(u.includes('external_ids'))json={imdb_id:'tt1234567'};else if(u.includes('/season/'))json={episodes:[{episode_number:1,name:'Pilot'}]};else if(u.includes('/tv/9006?'))json={seasons:[{season_number:1,episode_count:1}]};return r.fulfill({json});});
  await page.route('https://111movies.com/**',r=>r.fulfill({contentType:'text/html',body:'<script>location.replace("https://player.vidlove.cc/embed/fallback-fixture")</script>'}));
  await page.route('https://player.vidlove.cc/**',r=>r.fulfill({contentType:'text/html',body:'Unavailable provider fixture'}));
  await page.route(/\/(?:tv|movie)-torrents\?/,r=>r.fulfill({json:{sources:[{hash:'a'.repeat(40),quality:'720p',seeds:100,filename:'Fixture.S01E01.x264.mkv',title:'Fixture x264',remux:true,fileIndex:49}]}}));
  await page.route('**/yts?*',r=>r.fulfill({json:{title:movie.title,torrents:kind==='movie-alternate'?[]:[{hash:'a'.repeat(40),quality:'720p',seeds:100,video_codec:'x264'}]}}));
  await page.route('**/subtitles?*',r=>r.fulfill({json:{tracks:[]}}));
  let requested;await page.route('**/hls/start?*',r=>{requested=new URL(r.request().url());return r.fulfill({status:503,json:{error:'Fixture stops after verifying the requested position'}});});
  await page.goto((process.env.TV_TEST_URL||'http://127.0.0.1:8123')+'/tv.html?source=111Movies');await page.waitForSelector('.tv-card');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
  await page.locator('#tv-provider-alternate').waitFor({state:'visible'});
  await page.waitForFunction(()=>document.getElementById('player-iframe').contentWindow!==null);
  for(let i=0;i<50&&!page.frames().some(f=>f.url().includes('player.vidlove.cc'));i++)await page.waitForTimeout(100);
  const provider=page.frames().find(f=>f.url().includes('player.vidlove.cc'));
  await provider.evaluate(origin=>parent.postMessage({moviesProvider:true,type:'failure',detail:{position:3158,time:3158,reason:'servers-unavailable'}},origin),new URL(process.env.TV_TEST_URL||'http://127.0.0.1:8123').origin);
  await page.waitForFunction(expected=>document.getElementById('source-select').selectedOptions[0].textContent===expected,mediaType==='movie'?'YTS (Torrent)':'TV (Torrent)');
  for(let i=0;i<50&&!requested;i++)await page.waitForTimeout(100);
  assert.ok(requested,'fallback requests built-in HLS playback');
  assert.equal(requested.searchParams.get('t'),'3158');
  if(kind==='movie-alternate')assert.equal(requested.searchParams.get('file'),'49');
  assert.equal(await page.locator('#player-iframe').getAttribute('data-provider-origin'),null);
  assert.equal(await page.locator(':focus').getAttribute('id'),'tv-play-pause');
 }finally{await browser.close();}
});

test('paused metadata-only provider cannot cancel startup recovery', {skip:!process.env.TV_E2E,timeout:30000},async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 try {
  const page=await browser.newPage();
  const origin=process.env.TV_TEST_URL||'http://127.0.0.1:8123';
  await page.route(origin+'/controls-fixture',r=>r.fulfill({contentType:'text/html',body:'<div id="player-modal"><div class="player-header"></div><button id="close-modal">Back</button><iframe id="player-iframe" src="https://player.vidlove.cc/fixture"></iframe></div>'}));
  await page.route(origin+'/tv-provider-controls.js',r=>r.fulfill({contentType:'text/javascript',path:new URL('./tv-provider-controls.js',import.meta.url).pathname}));
  await page.route('https://player.vidlove.cc/**',r=>r.fulfill({contentType:'text/html',body:'Provider fixture'}));
  await page.goto(origin+'/controls-fixture');
  await page.clock.install();
  await page.evaluate(async origin=>{
   const {installProviderControls}=await import(origin+'/tv-provider-controls.js');installProviderControls();
   window.fallbacks=0;document.addEventListener('tv-provider-fallback',()=>window.fallbacks++);
   document.getElementById('player-iframe').dataset.providerOrigin='https://player.vidlove.cc';
  },origin);
  const provider=page.frames().find(f=>f.url().includes('vidlove'));
  await provider.evaluate(origin=>parent.postMessage({moviesProvider:true,type:'state',detail:{paused:true,ready:1,time:0,muted:true}},origin),origin);
  await page.waitForFunction(()=>document.getElementById('tv-provider-play').textContent.includes('▶'));
  await page.clock.fastForward(45001);
  assert.match(await page.locator('[role="status"]').textContent(),/Reconnecting/);
  await page.clock.fastForward(45001);
  assert.equal(await page.evaluate(()=>window.fallbacks),1);
 } finally {await browser.close();}
});
