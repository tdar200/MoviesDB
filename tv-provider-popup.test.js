import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {popupGuardScript} from './tv-provider-compat.mjs';

test('TV popup guard removes the covering ad iframe and blocks nested popup paths',{skip:!process.env.TV_E2E,timeout:30000},async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 try{
  const context=await browser.newContext({viewport:{width:1920,height:1080}});
  const popup=await readFile(new URL('./tv-provider-popup-guard.js',import.meta.url),'utf8');
  await context.addInitScript(popupGuardScript(popup,'https://app.example'));
  await context.route('https://app.example/**',r=>r.fulfill({contentType:'text/html',body:'<iframe style="width:1900px;height:1000px" src="https://player.vidlove.cc/embed/movie/fixture"></iframe>'}));
  await context.route('https://player.vidlove.cc/**',r=>r.fulfill({contentType:'text/html',body:`<style>body{margin:0}video{width:100vw;height:100vh}</style><video></video><button id="settings" onclick="this.textContent='Settings opened'">Settings</button><a id="ad-link" href="https://ads.example/" target="_blank">Ad</a><form id="ad-form" action="https://ads.example/" target="_blank"></form><iframe id="legitimate" srcdoc="<p>Subtitle settings</p>"></iframe><script>function addOverlay(){var f=document.createElement('iframe');f.className='ad-overlay';f.style.cssText='position:fixed;top:0;left:0;width:100%;height:100%;z-index:2147483646;opacity:.85';document.body.appendChild(f)}addOverlay();</script>`}));
  const page=await context.newPage();page.setDefaultTimeout(5000);await page.goto('https://app.example/tv.html');
  const frame=page.frames().find(f=>f.url().includes('vidlove'));
  await frame.waitForFunction(()=>document.querySelector('.ad-overlay')===null);
  assert.equal(await frame.locator('#legitimate').count(),1);
  await frame.evaluate(()=>addOverlay());await frame.waitForFunction(()=>document.querySelector('.ad-overlay')===null);
  assert.equal(await frame.evaluate(()=>document.elementFromPoint(innerWidth/2,innerHeight/2).tagName),'VIDEO');
  assert.equal(await frame.evaluate(()=>{try{window.open=()=>({});}catch{}return window.open('https://ads.example/')===null;}),true);
  await frame.locator('#ad-link').click();
  await frame.evaluate(()=>document.getElementById('ad-form').submit());
  await frame.evaluate(()=>{var f=document.createElement('iframe');f.id='clean';document.body.appendChild(f);});
  await frame.waitForFunction(()=>document.getElementById('clean').contentWindow.moviesPopupGuardInstalled);
  assert.equal(await frame.evaluate(()=>document.getElementById('clean').contentWindow.open('https://ads.example/')===null),true);
  await frame.locator('#settings').click();assert.equal(await frame.locator('#settings').textContent(),'Settings opened');
  await page.waitForTimeout(300);assert.equal(context.pages().length,1);
  // The app itself and unrelated top-level pages retain their normal API.
  assert.equal(await page.evaluate(()=>window.moviesPopupGuardInstalled),undefined);
  const unrelated=await context.newPage();await unrelated.goto('https://player.vidlove.cc/embed/movie/standalone');
  assert.equal(await unrelated.evaluate(()=>window.moviesPopupGuardInstalled),undefined);
 }finally{await browser.close();}
});
