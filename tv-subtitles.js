export function parseVtt(text) {
  const timestamp = value => {
    const parts = value.split(':').map(Number);
    return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
  };
  const entities = { amp:'&', lt:'<', gt:'>', quot:'"', apos:"'", nbsp:' ' };
  return String(text).replace(/\r/g,'').split(/\n\s*\n/).flatMap(block => {
    const lines=block.trim().split('\n');
    const index=lines.findIndex(line=>line.includes('-->'));
    if(index<0)return [];
    const match=/^((?:\d+:)?\d{2}:\d{2}\.\d{3})\s+-->\s+((?:\d+:)?\d{2}:\d{2}\.\d{3})/.exec(lines[index]);
    if(!match)return [];
    const start=timestamp(match[1]),end=timestamp(match[2]);
    if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)return [];
    const content=lines.slice(index+1).join('\n').replace(/<[^>]*>/g,'').replace(/&(amp|lt|gt|quot|apos|nbsp);/g,(_,name)=>entities[name]);
    return [{start,end,text:content}];
  });
}
export function cueText(cues, time, offset = 0) { return cues.filter(cue=>cue.start<=time-offset&&cue.end>time-offset).map(cue=>cue.text).join('\n'); }

// webOS native HLS can reject sidecar <track> files even when fetching the same
// VTT succeeds. Render text safely in the app, using the video's media clock.
export function installTvSubtitles(modal, video) {
  const overlay=document.createElement('div');overlay.className='tv-subtitles';modal.querySelector('.modal-content').append(overlay);
  let cues=[],controller=null,refresh=null,url='',offset=0;
  const render=()=>{overlay.textContent=cueText(cues,video.currentTime||0,offset);overlay.style.display=overlay.textContent?'block':'none';};
  async function load(target, signal) {
    try {
      const response=await fetch(target,{signal,cache:'no-store'});
      if(!response.ok)return;
      const text=await response.text();
      if(signal.aborted||target!==url)return;
      cues=parseVtt(text);render();
    } catch { /* A later refresh retries partial or not-yet-downloaded subtitles. */ }
  }
  document.addEventListener('tv-subtitle-track',event=>{
    controller?.abort();clearInterval(refresh);cues=[];url=event.detail?.url||'';offset=Number(event.detail?.offset)||0;render();
    if(!url)return;
    controller=new AbortController();const signal=controller.signal;
    load(url,signal);
    refresh=setInterval(()=>load(url,signal),15000);
  });
  video.addEventListener('timeupdate',render);
  video.addEventListener('seeked',render);
}
