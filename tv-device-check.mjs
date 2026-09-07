import { writeFile } from "node:fs/promises";
const inspector = process.argv[2];
if (!inspector || !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(inspector)) throw Error("Pass the local ares-inspect URL");
const reportPath = process.argv[3] || "/tmp/movies-device-results.json";
async function connect() {
  const targets = await (await fetch(inspector + "/json/list")).json();
  const target = targets.find((t) => t.url.includes("tv.html")) || targets[0];
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let next = 0;
  const pending = /* @__PURE__ */ new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, timer } = pending.get(m.id);
      clearTimeout(timer);
      pending.delete(m.id);
      resolve(m);
    }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error(method + " timed out"));
    }, 1e4);
    pending.set(id, { resolve, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev2 = async (expression) => {
    const r = await call("Runtime.evaluate", { expression, userGesture: true, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw Error(JSON.stringify(r.result.exceptionDetails));
    return r.result?.result?.value;
  };
  return { call, ev: ev2, close: () => {
    ws.close();
  } };
}
const c = await connect();
const report = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const save = () => writeFile(reportPath, JSON.stringify(report, null, 2));
const ev = c.ev;
const origin = await ev("location.origin");
async function until(fn, seconds = 150) {
  const end = Date.now() + seconds * 1e3;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(3e3);
  }
  return false;
}
const state = () => ev(`(function(){var v=document.getElementById('player-video');return {time:v.currentTime,ready:v.readyState,paused:v.paused,src:v.currentSrc.indexOf('/hls/')>=0?'HLS':'other',clock:document.querySelector('.tv-player-time').textContent,status:document.getElementById('yts-status').textContent,error:v.error&&v.error.message,title:document.getElementById('player-title').textContent};})()`);
async function frames() {
  const tree = (await c.call("Page.getFrameTree")).result.frameTree;
  const out = [];
  async function walk(f) {
    for (const child of f.childFrames || []) {
      try {
        const world = await c.call("Page.createIsolatedWorld", { frameId: child.frame.id, worldName: "playback-test" });
        const r = await c.call("Runtime.evaluate", { contextId: world.result.executionContextId, expression: `JSON.stringify({text:document.body?document.body.innerText.slice(0,250):'',videos:Array.from(document.querySelectorAll('video')).map(v=>({time:v.currentTime,ready:v.readyState,paused:v.paused,rect:v.getBoundingClientRect().toJSON(),error:v.error&&v.error.message}))})`, returnByValue: true });
        out.push({ host: new URL(child.frame.url).hostname, ...JSON.parse(r.result.result.value) });
      } catch {
      }
      await walk(child);
    }
  }
  await walk(tree);
  return out;
}
async function close() {
  await ev(`document.getElementById('close-modal').click()`);
  await sleep(1e3);
}
const titles = [{ name: "The Shawshank Redemption", id: 278, type: "movie" }, { name: "The Matrix", id: 603, type: "movie" }, { name: "Rick and Morty", id: 60625, type: "tv" }, { name: "Breaking Bad", id: 1396, type: "tv" }];
try {
  await c.call("Page.navigate", { url: origin + "/tv.html" });
  await until(() => ev(`!!document.querySelector('.tv-card')`), 60);
  for (const title of titles) {
    const result = { ...title, started: (/* @__PURE__ */ new Date()).toISOString() };
    report.push(result);
    console.log("TITLE", title.name);
    try {
      await ev(`document.getElementById('search').value=${JSON.stringify(title.name)};document.getElementById('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));`);
      if (!await until(() => ev(`!!document.querySelector('.tv-card[data-movie-id="${title.id}"]')`), 45)) throw Error("Title search timed out");
      await ev(`var card=document.querySelector('.tv-card[data-movie-id="${title.id}"]');card.focus();card.click();`);
      if (title.type === "tv") {
        await until(() => ev(`document.querySelector('#episode-select option')!==null`), 30);
        await ev(`var season=document.getElementById('season-select');if(season.value!=='1'){season.value='1';season.dispatchEvent(new Event('change',{bubbles:true}));}`);
        await until(() => ev(`document.querySelector('#episode-select option[value="1"]')!==null`), 30);
        await ev(`var episode=document.getElementById('episode-select');episode.value='1';episode.dispatchEvent(new Event('change',{bubbles:true}));`);
      }
      await ev(`var s=document.getElementById('source-select');s.value=Array.from(s.options).find(o=>o.textContent==='111Movies').value;s.dispatchEvent(new Event('change',{bubbles:true}));`);
      await sleep(15e3);
      result.provider111 = { frames: await frames() };
      await sleep(5e3);
      result.provider111.after = await frames();
      result.provider111.playing = result.provider111.after.some((frame, i) => frame.videos?.some((v, j) => v.rect?.width >= 640 && v.rect?.height >= 360 && v.ready >= 3 && v.time > (result.provider111.frames[i]?.videos?.[j]?.time || 0) + 1 && !v.paused && !v.error));
      console.log("111MOVIES", title.name, JSON.stringify(result.provider111));
      await save();
      const source = title.type === "movie" ? "YTS (Torrent)" : "TV (Torrent)";
      await ev(`var s=document.getElementById('source-select');s.value=Array.from(s.options).find(o=>o.textContent===${JSON.stringify(source)}).value;s.dispatchEvent(new Event('change',{bubbles:true}));`);
      const native = result.native = { source };
      let ticks = 0;
      native.started = await until(async () => {
        const s = await state();
        if (++ticks % 5 === 0) console.log("STARTING", title.name, JSON.stringify(s));
        return s.time > 2 && s.ready >= 3;
      }, 180);
      if (!native.started) {
        native.failure = await state();
        await save();
        await close();
        continue;
      }
      native.samples = [await state()];
      for (let i = 0; i < 6; i++) {
        await sleep(5e3);
        native.samples.push(await state());
      }
      native.advancing = native.samples.every((s, i) => !s.error && (i === 0 || s.time > native.samples[i - 1].time));
      native.continuous = native.samples.every((s, i) => !s.error && s.ready >= 3 && (i === 0 || s.time - native.samples[i - 1].time >= 3));
      console.log("PLAYBACK", title.name, native.continuous, JSON.stringify(native.samples));
      await save();
      await ev(`document.getElementById('tv-play-pause').click()`);
      const p = await state();
      await sleep(2e3);
      native.pause = p.paused && Math.abs((await state()).time - p.time) < 0.3;
      await ev(`document.getElementById('tv-play-pause').click()`);
      native.resume = await until(async () => (await state()).time > p.time + 1, 20);
      await ev(`document.dispatchEvent(new CustomEvent('tv-seek',{detail:60}))`);
      native.forward = await until(async () => {
        const s = await state();
        return s.time > 1 && s.ready >= 3;
      }, 120);
      native.forwardState = await state();
      if (native.forward) {
        await sleep(6e3);
        native.forwardAdvances = (await state()).time > native.forwardState.time + 3;
      }
      if (native.forward) {
        await ev(`document.dispatchEvent(new CustomEvent('tv-seek',{detail:-30}))`);
        native.backward = await until(async () => {
          const s = await state();
          return s.time > 1 && s.ready >= 3;
        }, 120);
        native.backwardState = await state();
        if (native.backward) {
          await sleep(6e3);
          native.backwardAdvances = (await state()).time > native.backwardState.time + 3;
        }
      }
      if (title.type === "tv") {
        await ev(`document.getElementById('next-episode').click()`);
        native.nextEpisode = await until(async () => {
          const s = await state();
          return s.title.includes("S1E2") && s.time > 2 && s.ready >= 3;
        }, 180);
        native.nextState = await state();
        if (native.nextEpisode) {
          const t = (await state()).time;
          await sleep(1e4);
          native.nextAdvances = (await state()).time > t + 5;
        }
      }
      await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'GoBack',keyCode:461,bubbles:true}))`);
      await sleep(500);
      native.back = await ev(`document.getElementById('player-modal').style.display==='none'`);
      native.restoredFocus = await ev(`document.activeElement.dataset.movieId===${JSON.stringify(String(title.id))}`);
      console.log("RESULT", JSON.stringify(result));
      await save();
    } catch (error) {
      result.error = error.message;
      console.log("ERROR", title.name, error.message);
      await save();
      try {
        await close();
      } catch {
      }
    }
  }
} finally {
  await save();
  await c.call("Page.navigate", { url: origin + "/tv.html" });
  c.close();
  process.exit(report.length === titles.length && report.every((r) => r.provider111?.playing && r.native?.continuous && r.native.pause && r.native.resume && r.native.forwardAdvances && r.native.backwardAdvances && r.native.back && r.native.restoredFocus && (r.type !== "tv" || r.native.nextAdvances)) ? 0 : 1);
}
