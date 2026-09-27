import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
export function compatibilityScript(bridge, parentOrigin) {
  const settings = JSON.stringify({ parentOrigin }).replace(/</g, '\\u003c');
  return `(function(){if(location.hostname!=='player.vidlove.cc')return;window.moviesCompat=${settings};${bridge}\n})();`;
}
export function popupGuardScript(popup, parentOrigin) {
  const origin = JSON.stringify(parentOrigin).replace(/</g, '\\u003c');
  return `(function(){var ancestors=Array.prototype.slice.call(location.ancestorOrigins||[]);if(ancestors.indexOf(${origin})<0)return;if(location.hostname!=='player.vidlove.cc'&&ancestors.indexOf('https://player.vidlove.cc')<0)return;${popup}\n})();`;
}
export function tvAppIsRunning(output, appId) {
  return String(output).split(/\r?\n/).some(line => line.trim().split(/\s+-\s+display\s+/)[0] === appId);
}
export function startTvProviderCompat({ device = 'lgtv', appId = 'com.moviesdb.tv', appOrigin, log = console.log } = {}) {
  let stopped = false, child, socket, retry;
  const parentOrigin = new URL(appOrigin).origin;
  const preload = new URL('./tv-inspect-loopback.mjs', import.meta.url).href;
  const bridgeFile = new URL('./tv-provider-bridge.js', import.meta.url);
  async function attach(inspector) {
    let next = 0;
    const pending = new Map();
    const targets = await (await fetch(inspector + '/json/list', { signal: AbortSignal.timeout(5000) })).json();
    const target = targets.find(t => { try { const u = new URL(t.url); return u.origin === parentOrigin && u.pathname === '/tv.html'; } catch { return false; } });
    if (!target) throw new Error('Movies TV app is not open');
    const url = new URL(target.webSocketDebuggerUrl);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Inspector must stay on loopback');
    socket = new WebSocket(url);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    if (stopped) { socket.close(); return; }
    const contexts = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const job = pending.get(message.id); clearTimeout(job.timer); pending.delete(message.id);
        message.error ? job.reject(new Error(message.error.message)) : job.resolve(message.result);
      }
      if (message.method === 'Runtime.executionContextCreated') { const c = message.params.context; if (c.auxData?.isDefault) contexts.set(c.auxData.frameId, c.id); }
      if (message.method === 'Runtime.executionContextsCleared') contexts.clear();
    });
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('TV inspector timed out')); }, 8000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
    const bridge = await readFile(bridgeFile, 'utf8');
    const popup = await readFile(new URL('./tv-provider-popup-guard.js', import.meta.url), 'utf8');
    const source = popupGuardScript(popup, parentOrigin) + compatibilityScript(bridge, parentOrigin);
    // Page.enable is essential on this webOS build: registration alone is inert.
    await call('Page.enable');
    await call('Page.addScriptToEvaluateOnNewDocument', { source });
    await call('Runtime.enable');
    const tree = await call('Page.getFrameTree');
    const frame = tree.frameTree.childFrames?.find(f => { try { return new URL(f.frame.url).hostname === 'player.vidlove.cc'; } catch { return false; } });
    if (frame && contexts.has(frame.frame.id)) {
      const contextId = contexts.get(frame.frame.id);
      // Apply immediately, then reload only an already-crashed provider frame.
      await call('Runtime.evaluate', { contextId, expression: source });
      const crashed = await call('Runtime.evaluate', { contextId, expression: "document.body.innerText.includes('Something went wrong loading the player.')", returnByValue: true });
      if (crashed.result?.value) await call('Runtime.evaluate', { contextId, expression: 'location.reload()' });
    }
    log(`[TV] 111Movies compatibility bridge connected (${inspector}; loopback only).`);
    await new Promise(resolve => { socket.addEventListener('close', resolve, { once: true }); socket.addEventListener('error', resolve, { once: true }); });
    for (const job of pending.values()) { clearTimeout(job.timer); job.reject(new Error('TV disconnected')); }
    pending.clear();
  }
  function inspect() {
    if (stopped) return;
    let output = '', attached = false;
    child = spawn(process.execPath, ['--import', preload, process.env.TV_ARES_INSPECT || join(dirname(process.execPath), 'ares-inspect'), '-d', device, appId], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const cleanup = () => { socket?.close(); child?.kill('SIGTERM'); };
    child.stdout.on('data', chunk => {
      output = (output + chunk.toString()).slice(-2000);
      const match = output.match(/Application Debugging - (http:\/\/localhost:\d+)/);
      if (!match || attached) return;
      attached = true;
      attach(match[1]).catch(error => { if (!stopped) log('[TV] ' + error.message); }).finally(cleanup);
    });
    child.stderr.on('data', () => {});
    child.on('error', error => { if (!stopped) log('[TV] Inspector unavailable: ' + error.message); });
    child.on('close', () => { if (!stopped) retry = setTimeout(poll, 15000); });
  }
  function poll() {
    if (stopped) return;
    let output = "";
    const launcher = process.env.TV_ARES_LAUNCH || join(dirname(process.execPath), "ares-launch");
    child = spawn(process.execPath, [launcher, "-d", device, "--running"], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", chunk => { output = (output + chunk.toString()).slice(-4000); });
    child.stderr.on("data", () => {});
    child.on("error", error => { if (!stopped) log("[TV] App check unavailable: " + error.message); });
    child.on("close", code => {
      if (stopped) return;
      if (code === 0 && tvAppIsRunning(output, appId)) inspect();
      else retry = setTimeout(poll, 15000);
    });
  }
  poll();
  return () => { stopped = true; clearTimeout(retry); socket?.close(); child?.kill('SIGTERM'); };
}
