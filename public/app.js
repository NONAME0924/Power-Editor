const pxPerSec = 80;
const snapSeconds = 0.25;
const snapDistance = 0.18;

const state = {
  assets: [],
  timeline: { video: [], audio: [] },
  selected: null,
  playing: false,
  startedAt: 0,
  playFrom: 0,
  previewClipId: null,
  sourceReady: null,
  pendingSeek: null,
  timelineSeeking: false,
  seekSerial: 0,
  audioEls: {}, // clipId -> audio element
  drag: null
};

const $ = id => document.getElementById(id);
const assetsEl = $("assets");
const videoTrack = $("videoTrack");
const audioTrack = $("audioTrack");
const previewVideo = $("previewVideo");
const scrub = $("scrub");
const statusEl = $("status");
const monitorFrame = $("monitorFrame");
const timelineWrap = document.querySelector(".timeline-viewport");

function formatTime(value) {
  const s = Math.max(0, value || 0);
  const minutes = Math.floor(s / 60);
  const seconds = Math.floor(s % 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function timelineDuration() {
  return Math.max(
    30,
    ...state.timeline.video.map(c => c.start + c.duration),
    ...state.timeline.audio.map(c => c.start + c.duration)
  );
}

function projectVideoSize() {
  const clips = state.timeline.video.filter(c => c.width && c.height);
  const pool = clips.length ? clips : state.assets.filter(a => a.type === "video" && a.width && a.height);
  const largest = pool.sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
  return largest ? { width: largest.width, height: largest.height } : { width: 1920, height: 1080 };
}

let fitFrameScheduled = false;
function fitMonitorFrame() {
  if ($("fillPreview")?.checked) {
    monitorFrame.classList.add("fill");
    monitorFrame.style.width = "100%";
    monitorFrame.style.height = "100%";
    return;
  }
  monitorFrame.classList.remove("fill");
  const stage = monitorFrame.parentElement;
  
  // 使用 clientWidth/Height 並扣除 padding (CSS 中 .preview-stage 的 padding 為 20px)
  // 確保計算基礎是固定的內部空間，避免佈局回饋迴圈導致容器無限增長
  const maxWidth = Math.max(0, stage.clientWidth - 40);
  const maxHeight = Math.max(0, stage.clientHeight - 40);
  
  if (maxWidth <= 0 || maxHeight <= 0) return;

  const { width, height } = projectVideoSize();
  const aspect = width / height;
  
  let frameWidth = maxWidth;
  let frameHeight = frameWidth / aspect;
  
  if (frameHeight > maxHeight) {
    frameHeight = maxHeight;
    frameWidth = frameHeight * aspect;
  }
  monitorFrame.style.width = `${Math.floor(frameWidth)}px`;
  monitorFrame.style.height = `${Math.floor(frameHeight)}px`;
}

function setStatus(text, danger = false) {
  statusEl.textContent = text || "";
  statusEl.style.color = danger ? "var(--danger)" : "var(--muted)";
}

function clipTrack(clip) {
  return clip?.track || clip?.type;
}

function selectedClip() {
  for (const track of ["video", "audio"]) {
    const clip = state.timeline[track].find(c => c.id === state.selected);
    if (clip) return clip;
  }
  return null;
}

async function upload(file) {
  setStatus(`正在匯入 ${file.name}...`);
  const res = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
  const asset = await res.json();
  if (!res.ok) throw new Error(asset.error || "匯入失敗");
  if (!asset.duration) asset.duration = await readDuration(asset);
  state.assets.push(asset);
  renderAssets();
  setStatus(`已匯入 ${file.name}`);
}

function readDuration(asset) {
  return new Promise(resolve => {
    const el = document.createElement(asset.type === "video" ? "video" : "audio");
    el.preload = "metadata";
    el.src = asset.url;
    el.onloadedmetadata = () => {
      if (asset.type === "video") {
        asset.width = asset.width || el.videoWidth || 0;
        asset.height = asset.height || el.videoHeight || 0;
        asset.hasVideo = true;
      }
      resolve(Number.isFinite(el.duration) ? el.duration : 5);
    };
    el.onerror = () => resolve(asset.duration || 5);
  });
}

function renderAssets() {
  const dropZone = $("dropZone");
  const assetsGrid = $("assets");
  
  if (state.assets.length === 0) {
    dropZone.style.display = "flex";
    assetsGrid.style.display = "none";
    return;
  }

  dropZone.style.display = "none";
  assetsGrid.style.display = "grid";
  assetsGrid.innerHTML = "";

  state.assets.forEach(asset => {
    const card = document.createElement("div");
    card.className = `asset-card ${asset.type}`;
    card.draggable = true;
    
    const iconSvg = asset.type === "video" 
      ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/></svg>`
      : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;

    card.innerHTML = `
      <div class="asset-thumb">
        ${iconSvg}
        <div class="asset-duration">${formatTime(asset.duration)}</div>
      </div>
      <div class="asset-info">
        <div class="asset-title" title="${asset.name}">${asset.name}</div>
      </div>
    `;

    card.addEventListener("dragstart", event => {
      event.dataTransfer.setData("application/json", JSON.stringify(asset));
    });
    assetsGrid.appendChild(card);
  });
}

function snapTime(value, excludeId = null) {
  const points = [0];
  const max = timelineDuration() + 30;
  for (let t = 0; t <= max; t += 1) points.push(t);
  for (const track of ["video", "audio"]) {
    state.timeline[track].forEach(clip => {
      if (clip.id === excludeId) return;
      points.push(clip.start, clip.start + clip.duration);
    });
  }
  let best = Math.max(0, Math.round(value / snapSeconds) * snapSeconds);
  let bestDiff = Math.abs(value - best);
  points.forEach(point => {
    const diff = Math.abs(value - point);
    if (diff < bestDiff && diff <= snapDistance) {
      best = point;
      bestDiff = diff;
    }
  });
  return Math.max(0, Number(best.toFixed(3)));
}

function showGuide(track, time) {
  const guide = track === "video" ? $("videoGuide") : $("audioGuide");
  guide.style.display = "block";
  guide.style.left = `${time * pxPerSec}px`;
}

function hideGuides() {
  $("videoGuide").style.display = "none";
  $("audioGuide").style.display = "none";
}

function addClip(asset, track, start, linkedGroup = null) {
  const duration = Math.max(0.1, asset.duration || 5);
  const clip = {
    id: crypto.randomUUID(),
    group: linkedGroup,
    name: asset.name,
    url: asset.url,
    type: track,
    assetType: asset.type,
    track,
    start: snapTime(start),
    offset: 0,
    duration,
    sourceDuration: duration,
    speed: 1,
    volume: 1,
    hasAudio: !!asset.hasAudio,
    useAudio: track === "video" ? !asset.hasAudio : true,
    width: asset.width || 0,
    height: asset.height || 0
  };
  state.timeline[track].push(clip);
  state.selected = clip.id;
  return clip;
}

function addAssetToTimeline(asset, track, start) {
  if (asset.type === "audio" && track !== "audio") return;
  if (asset.type === "video" && track !== "video") return;

  if (asset.type === "audio") {
    addClip(asset, "audio", start, null);
    renderTimeline();
    return;
  }

  const group = crypto.randomUUID();
  const videoClip = addClip(asset, "video", start, group);
  if (asset.type === "video" && asset.hasAudio && $("splitAudio").checked) {
    videoClip.useAudio = false;
    const audioClip = addClip(asset, "audio", start, group);
    audioClip.name = `${asset.name} 原音`;
  }
  renderTimeline();
}

function renderRuler() {
  const total = timelineDuration();
  const width = Math.max(1100, (total + 10) * pxPerSec);
  const ruler = $("ruler");
  ruler.style.width = `${width}px`;
  ruler.innerHTML = "";

  // 渲染大刻度 (每秒)
  for (let i = 0; i <= total + 10; i += 1) {
    const tick = document.createElement("div");
    tick.className = "ruler-tick";
    tick.style.left = `${i * pxPerSec}px`;
    // 每 5 秒顯示一次文字，避免過擠
    if (i % 5 === 0) {
      tick.textContent = formatTime(i);
    } else {
      tick.style.height = "6px"; // 非整 5 秒的短一點
    }
    ruler.appendChild(tick);

    // 渲染小刻度 (每 0.2 秒)
    if (i < total + 10) {
      for (let j = 1; j < 5; j++) {
        const sub = document.createElement("div");
        sub.className = "ruler-sub-tick";
        sub.style.left = `${(i + j * 0.2) * pxPerSec}px`;
        ruler.appendChild(sub);
      }
    }
  }
  
  scrub.max = total;
  const current = Number(scrub.value || 0);
  $("timeInput").value = current.toFixed(2);
  $("timeTotal").textContent = `/ ${formatTime(total)}`;
  updatePlayhead(current);
}

function updatePlayhead(time) {
  const playhead = $("playhead");
  if (!playhead) return;
  playhead.style.display = "block";
  playhead.style.left = `${Math.max(0, time) * pxPerSec}px`;
}

function setTimelineTime(time, options = {}) {
  if (options.stopPlayback !== false) stop();
  const total = timelineDuration();
  const next = Math.max(0, Math.min(total, time));
  scrub.value = next;
  $("timeInput").value = next.toFixed(2);
  $("timeTotal").textContent = `/ ${formatTime(total)}`;
  updatePlayhead(next);
  syncPreview(next);
}

function renderTimeline() {
  renderRuler();
  renderTrack(videoTrack, "video");
  renderTrack(audioTrack, "audio");
  renderInspector();
  
  if (!fitFrameScheduled) {
    fitFrameScheduled = true;
    requestAnimationFrame(() => {
      fitMonitorFrame();
      fitFrameScheduled = false;
    });
  }
}

function renderTrack(el, track) {
  const guide = el.querySelector(".snap-line");
  el.innerHTML = "";
  el.appendChild(guide);
  el.style.width = `${Math.max(1100, (timelineDuration() + 10) * pxPerSec)}px`;
  state.timeline[track].forEach(clip => {
    const node = document.createElement("div");
    node.className = `timeline-clip ${track}${clip.id === state.selected ? " selected" : ""}`;
    node.style.left = `${clip.start * pxPerSec}px`;
    // 扣除 1px 寬度以產生視覺上的分割感
    node.style.width = `${Math.max(5, clip.duration * pxPerSec - 1)}px`;
    node.innerHTML = `
      <div class="clip-label">${clip.name}</div>
      <div class="clip-time">${formatTime(clip.start)} (${clip.speed}x)</div>
      <div class="handle-resize-left resizeHandleLeft"></div>
      <div class="handle-resize resizeHandle"></div>
    `;
    node.title = "拖曳移動，左/右側調整，雙擊刪除";
    node.addEventListener("pointerdown", event => startPointerEdit(event, clip, track, "move"));
    node.querySelector(".resizeHandleLeft").addEventListener("pointerdown", event => startPointerEdit(event, clip, track, "left"));
    node.querySelector(".resizeHandle").addEventListener("pointerdown", event => startPointerEdit(event, clip, track, "right"));
    node.addEventListener("dblclick", () => deleteClip(clip.id));
    el.appendChild(node);
  });
}

function startPointerEdit(event, clip, track, mode) {
  event.preventDefault();
  event.stopPropagation();
  state.selected = clip.id;
  state.drag = {
    id: clip.id,
    track,
    mode, // "move", "left", "right"
    x: event.clientX,
    start: clip.start,
    duration: clip.duration,
    offset: clip.offset,
    speed: clip.speed || 1,
    sourceDuration: clip.sourceDuration
  };
  event.currentTarget.setPointerCapture?.(event.pointerId);
  renderTimeline();
}

function deleteClip(id) {
  for (const track of ["video", "audio"]) {
    state.timeline[track] = state.timeline[track].filter(c => c.id !== id);
  }
  if (state.selected === id) state.selected = null;
  renderTimeline();
}

function moveLinkedGroup(clip, delta) {
  if (!clip.group) return;
  for (const track of ["video", "audio"]) {
    state.timeline[track].forEach(other => {
      if (other.id !== clip.id && other.group === clip.group) {
        other.start = Math.max(0, other.start + delta);
      }
    });
  }
}

window.addEventListener("pointermove", event => {
  if (!state.drag) return;
  const clip = state.timeline[state.drag.track].find(c => c.id === state.drag.id);
  if (!clip) return;
  const delta = (event.clientX - state.drag.x) / pxPerSec;
  const isStretch = event.shiftKey || $("stretchMode").checked;
  
  if (state.drag.mode === "right") {
    const end = snapTime(state.drag.start + state.drag.duration + delta, clip.id);
    const newDur = Math.max(0.1, end - clip.start);

    // 計算原本的素材區間長度 (秒)
    const sourceRange = state.drag.duration * state.drag.speed;
    const maxAvailableInTrim = (clip.sourceDuration - clip.offset) / state.drag.speed;

    if (isStretch || newDur > maxAvailableInTrim) {
      // 進入「拉伸模式」：如果手動開啟，或者拉動長度超過了現有素材
      const newSpeed = sourceRange / newDur;
      // 移除了人為的倍速限制 (改為極廣範圍)
      clip.speed = Math.max(0.001, Math.min(100, newSpeed));
      clip.duration = newDur;
    } else {
      // 一般「裁剪模式」
      clip.speed = state.drag.speed; // 恢復拖動前的速度
      clip.duration = newDur;
    }
    showGuide(state.drag.track, clip.start + clip.duration);
  } else if (state.drag.mode === "left") {
    const nextStart = snapTime(state.drag.start + delta, clip.id);
    const actualDelta = nextStart - state.drag.start;
    const nextDur = Math.max(0.1, state.drag.duration - actualDelta);
    const sourceRange = state.drag.duration * state.drag.speed;

    if (isStretch) {
      const newSpeed = sourceRange / nextDur;
      clip.start = nextStart;
      clip.speed = Math.max(0.001, Math.min(100, newSpeed));
      clip.duration = nextDur;
    } else {
      const offsetDelta = actualDelta * clip.speed;
      const newOffset = Math.max(0, state.drag.offset + offsetDelta);
      // 確保 offset 不會超過鎖定的總長
      if (newOffset < clip.sourceDuration - 0.05) {
        clip.start = state.drag.start + (newOffset - state.drag.offset) / clip.speed;
        clip.offset = newOffset;
        clip.duration = Math.max(0.1, state.drag.duration - (clip.start - state.drag.start));
      }
    }
    showGuide(state.drag.track, clip.start);
  } else {
    const nextStart = snapTime(state.drag.start + delta, clip.id);
    const moveDelta = nextStart - clip.start;
    clip.start = nextStart;
    moveLinkedGroup(clip, moveDelta);
    showGuide(state.drag.track, clip.start);
  }
  renderTimeline();
});

window.addEventListener("pointerup", () => {
  state.drag = null;
  state.timelineSeeking = false;
  hideGuides();
});

function wireLane(el, track) {
  el.addEventListener("dragover", event => {
    event.preventDefault();
    el.classList.add("over");
    showGuide(track, snapTime(event.offsetX / pxPerSec));
  });
  el.addEventListener("dragleave", () => {
    el.classList.remove("over");
    hideGuides();
  });
  el.addEventListener("drop", event => {
    event.preventDefault();
    el.classList.remove("over");
    hideGuides();
    const asset = JSON.parse(event.dataTransfer.getData("application/json") || "null");
    if (!asset) return;
    addAssetToTimeline(asset, track, event.offsetX / pxPerSec);
  });
  el.addEventListener("pointerdown", event => {
    if (event.target === el) {
      state.selected = null;
      renderInspector();
      beginTimelineSeek(event, el);
    }
  });
}

function timeFromPointer(event, element) {
  const rect = element.getBoundingClientRect();
  return (event.clientX - rect.left) / pxPerSec;
}

function beginTimelineSeek(event, element) {
  event.preventDefault();
  stop();
  state.timelineSeeking = true;
  state.seekElement = element;
  state.pendingTimelineSeek = null;
  timelineWrap.setPointerCapture?.(event.pointerId);
  setTimelineTime(timeFromPointer(event, element), { stopPlayback: false });
}

$("ruler").addEventListener("pointerdown", event => beginTimelineSeek(event, $("ruler")));

window.addEventListener("pointermove", event => {
  if (!state.timelineSeeking || state.drag) return;
  if (!state.seekElement) return;
  const t = timeFromPointer(event, state.seekElement);
  const total = timelineDuration();
  const next = Math.max(0, Math.min(total, t));
  scrub.value = next;
  $("timeInput").value = next.toFixed(2);
  $("timeTotal").textContent = `/ ${formatTime(total)}`;
  updatePlayhead(next);
  syncPreview(next);
});

$("timeInput").addEventListener("change", event => {
  const val = parseFloat(event.target.value || 0);
  setTimelineTime(val);
});

function activeVideo(time) {
  return [...state.timeline.video].reverse().find(c => time >= c.start && time < c.start + c.duration);
}

function stopAudioPreview() {
  Object.values(state.audioEls).forEach(el => {
    el.pause();
    el.remove();
  });
  state.audioEls = {};
}

const previewCanvas = $("previewCanvas");
const ctx = previewCanvas.getContext("2d", { alpha: false });

const previewState = {
  targetTime: 0,
  isSeeking: false,
  pendingSeek: null,
  lastDrawnId: null
};

// 繪製循環：將影片影格同步到 Canvas
function startCanvasLoop() {
  function render() {
    if (state.previewClipId) {
      const { width, height } = projectVideoSize();
      if (previewCanvas.width !== width) {
        previewCanvas.width = width;
        previewCanvas.height = height;
      }
      
      ctx.clearRect(0, 0, width, height);
      // 繪製影片
      try {
        ctx.drawImage(previewVideo, 0, 0, width, height);
      } catch (e) {}
    }
    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);
}
startCanvasLoop();

// 強大的 Seek 隊列控制
previewVideo.addEventListener("seeked", () => {
  previewState.isSeeking = false;
  if (previewState.pendingSeek !== null) {
    const nextTime = previewState.pendingSeek;
    previewState.pendingSeek = null;
    requestSeek(nextTime);
  }
});

function requestSeek(time) {
  if (previewState.isSeeking) {
    previewState.pendingSeek = time;
    return;
  }
  
  previewState.isSeeking = true;
  previewVideo.currentTime = time;
}

function syncPreview(time, options = {}) {
  const clip = activeVideo(time);
  const emptyHint = $("emptyPreview");
  
  if (!clip) {
    emptyHint.style.display = "block";
    previewCanvas.style.display = "none";
    previewVideo.pause();
    if (state.previewClipId) {
      previewVideo.removeAttribute("src");
      previewVideo.load();
    }
    state.previewClipId = null;
    return;
  }

  emptyHint.style.display = "none";
  previewCanvas.style.display = "block";
  // 核心修復：使用倍速計算 targetTime，並嚴格限制在 clip.sourceDuration 之內 (防止溢出顯示)
  let targetTime = clip.offset + (time - clip.start) * (clip.speed || 1);
  targetTime = Math.max(0, Math.min(clip.sourceDuration - 0.001, targetTime));

  // 片段切換
  if (state.previewClipId !== clip.id) {
    state.previewClipId = clip.id;
    previewVideo.pause();
    previewVideo.src = clip.url;
    previewVideo.load();
    
    const onReady = () => {
      previewVideo.removeEventListener("canplay", onReady);
      previewVideo.muted = !clip.useAudio;
      previewState.isSeeking = false;
      previewState.pendingSeek = null;
      requestSeek(targetTime);
      if (state.playing || options.autoplay) {
        previewVideo.play().catch(() => {});
      }
    };
    previewVideo.addEventListener("canplay", onReady);
    return;
  }

  // 同步邏輯
  previewVideo.muted = !clip.useAudio;
  previewVideo.playbackRate = clip.speed || 1;

  if (state.playing) {
    const drift = Math.abs(previewVideo.currentTime - targetTime);
    if (drift > 0.5 || options.force) {
      requestSeek(targetTime);
    }
    if (previewVideo.paused) {
      previewVideo.play().catch(() => {});
    }
  } else {
    // 拖動模式：使用 Seek 隊列
    requestSeek(targetTime);
  }
}

function syncAudio(time) {
  if (!state.playing) return;

  const activeIds = new Set();
  
  // 找出目前時間點應該播放的音軌
  state.timeline.audio.forEach(clip => {
    if (time >= clip.start && time < clip.start + clip.duration) {
      activeIds.add(clip.id);
      
      let el = state.audioEls[clip.id];
      if (!el) {
        // 新增並播放
        el = document.createElement("audio");
        el.src = clip.url;
        el.volume = clip.volume ?? 1;
        el.playbackRate = clip.speed || 1;
        const targetCurrentTime = clip.offset + (time - clip.start) * clip.speed;
        el.currentTime = targetCurrentTime;
        el.play().catch(() => {});
        state.audioEls[clip.id] = el;
      } else {
        // 檢查偏移 (drift)
        const targetTime = clip.offset + (time - clip.start) * clip.speed;
        const drift = Math.abs(el.currentTime - targetTime);
        if (drift > 0.2) {
          el.currentTime = targetTime;
        }
        el.playbackRate = clip.speed || 1;
        if (el.paused) el.play().catch(() => {});
      }
    }
  });

  // 移除不再需要的音軌
  Object.keys(state.audioEls).forEach(id => {
    if (!activeIds.has(id)) {
      const el = state.audioEls[id];
      el.pause();
      el.remove();
      delete state.audioEls[id];
    }
  });
}

function playAudioFrom(time) {
  stopAudioPreview();
  syncAudio(time);
}

function tick() {
  if (!state.playing) return;
  
  const elapsed = (performance.now() - state.startedAt) / 1000;
  const current = state.playFrom + elapsed;
  const total = timelineDuration();

  if (current >= total) {
    setTimelineTime(total);
    stop();
    return;
  }

  scrub.value = current;
  $("timeInput").value = current.toFixed(2);
  $("timeTotal").textContent = `/ ${formatTime(total)}`;
  updatePlayhead(current);
  syncPreview(current);
  syncAudio(current);
  
  requestAnimationFrame(tick);
}

function play() {
  if (state.playing) return;
  stop();
  state.playFrom = Number(scrub.value || 0);
  state.playing = true;
  state.startedAt = performance.now();
  
  playAudioFrom(state.playFrom);
  syncPreview(state.playFrom, { autoplay: true, force: true });
  tick();
}

function stop() {
  state.playing = false;
  previewVideo.pause();
  previewVideo.playbackRate = 1;
  stopAudioPreview();
}

function splitSelectedClip() {
  const selected = selectedClip();
  if (!selected) return;
  const time = Number(scrub.value);
  
  const groupId = selected.group;
  const clipsToProcess = [];
  
  if (groupId) {
    // 找出所有同群組的片段
    for (const track of ["video", "audio"]) {
      state.timeline[track].forEach(c => {
        if (c.group === groupId) clipsToProcess.push(c);
      });
    }
  } else {
    clipsToProcess.push(selected);
  }

  const newGroupId = crypto.randomUUID();
  let splitCount = 0;
  let newSelectedId = state.selected;

  clipsToProcess.forEach(clip => {
    if (time > clip.start && time < clip.start + clip.duration) {
      // 橫切片段
      const splitPointRel = time - clip.start;
      const originalDuration = clip.duration;
      const splitSourcePoint = clip.offset + splitPointRel * clip.speed;
      
      const newClip = {
        ...clip,
        id: crypto.randomUUID(),
        group: newGroupId,
        start: time,
        offset: splitSourcePoint,
        duration: originalDuration - splitPointRel,
        sourceDuration: clip.sourceDuration
      };
      
      // 鎖定前半段的 sourceDuration，防止拉長時露出後續內容
      clip.duration = splitPointRel;
      clip.sourceDuration = splitSourcePoint;
      
      state.timeline[clip.track].push(newClip);
      splitCount++;
      
      if (clip.id === state.selected) newSelectedId = newClip.id;
    } else if (clip.start >= time) {
      // 整個片段都在切割點之後，直接換到新組
      clip.group = newGroupId;
    }
  });

  if (splitCount > 0) {
    state.selected = newSelectedId;
    renderTimeline();
    setStatus(`已分割並重組 ${splitCount} 個關聯片段`);
  } else {
    setStatus("播放頭位置沒有可分割的內容", true);
  }
}

function renderInspector() {
  const clip = selectedClip();
  $("selectedName").textContent = clip ? clip.name : "未選取片段";
  const disabled = !clip;
  for (const id of ["clipStart", "clipDuration", "clipSpeed", "clipVolume", "clipUseAudio", "deleteClip", "splitBtn"]) $(id).disabled = disabled;
  $("clipUseAudioLabel").style.display = clip?.track === "video" && clip.hasAudio ? "flex" : "none";
  if (!clip) {
    $("clipStart").value = "";
    $("clipDuration").value = "";
    $("clipSpeed").value = "";
    $("clipVolume").value = "";
    $("clipUseAudio").checked = false;
    return;
  }
  $("clipStart").value = clip.start.toFixed(2);
  $("clipDuration").value = clip.duration.toFixed(2);
  $("clipSpeed").value = clip.speed.toFixed(1);
  $("clipVolume").value = clip.volume.toFixed(1);
  $("clipUseAudio").checked = !!clip.useAudio;
}

function updateSelected(mutator) {
  const clip = selectedClip();
  if (!clip) return;
  mutator(clip);
  renderTimeline();
  syncPreview(Number(scrub.value || 0));
}

async function loadMedia() {
  const res = await fetch("/api/media");
  state.assets = await res.json();
  await Promise.all(state.assets.map(async a => {
    if (!a.duration) a.duration = await readDuration(a);
  }));
  renderAssets();
  renderTimeline();
  fitMonitorFrame();
}

$("fileInput").addEventListener("change", event => [...event.target.files].forEach(upload));
$("dropZone").addEventListener("dragover", event => {
  event.preventDefault();
  $("dropZone").classList.add("drag");
});
$("dropZone").addEventListener("dragleave", () => $("dropZone").classList.remove("drag"));
$("dropZone").addEventListener("drop", event => {
  event.preventDefault();
  $("dropZone").classList.remove("drag");
  [...event.dataTransfer.files].forEach(upload);
});

$("makeTts").addEventListener("click", async () => {
  setStatus("正在生成 Edge TTS 語音...");
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ text: $("ttsText").value, voice: $("voice").value })
  });
  const asset = await res.json();
  if (!res.ok) {
    setStatus(asset.error || "TTS 失敗", true);
    return;
  }
  if (!asset.duration) asset.duration = await readDuration(asset);
  state.assets.push(asset);
  renderAssets();
  setStatus("已生成語音素材，可拖到聲音時間軸。");
});

$("exportBtn").addEventListener("click", async () => {
  setStatus("正在用 ffmpeg 產出 MP4...");
  const res = await fetch("/api/export", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ ...state.timeline, duration: timelineDuration() })
  });
  const out = await res.json();
  if (!res.ok) {
    setStatus(out.error || "匯出失敗", true);
    return;
  }
  setStatus(`匯出完成：${out.file}`);
  window.open(out.url, "_blank");
});

$("playBtn").addEventListener("click", play);
$("stopBtn").addEventListener("click", stop);
$("fillPreview").addEventListener("change", event => {
  previewVideo.classList.toggle("fill", event.target.checked);
  fitMonitorFrame();
});
$("deleteClip").addEventListener("click", () => selectedClip() && deleteClip(selectedClip().id));
$("splitBtn").addEventListener("click", splitSelectedClip);

$("clipStart").addEventListener("change", event => updateSelected(clip => { clip.start = snapTime(Number(event.target.value || 0), clip.id); }));
$("clipDuration").addEventListener("change", event => updateSelected(clip => {
  const newDur = Math.max(0.1, Number(event.target.value || 0.1));
  const maxAvailable = (clip.sourceDuration - clip.offset) / clip.speed;
  clip.duration = Math.min(maxAvailable, newDur);
}));
$("clipSpeed").addEventListener("change", event => updateSelected(clip => {
  const oldSpeed = clip.speed;
  const newSpeed = Math.max(0.1, Math.min(10, Number(event.target.value || 1)));
  clip.speed = newSpeed;
  // 速度改變時，duration 也要跟著變 (保持 source 範圍不變)
  clip.duration = (clip.duration * oldSpeed) / newSpeed;
}));
$("clipVolume").addEventListener("change", event => updateSelected(clip => { clip.volume = Math.max(0, Math.min(2, Number(event.target.value || 1))); }));
$("clipUseAudio").addEventListener("change", event => updateSelected(clip => { clip.useAudio = event.target.checked; }));

// 快捷鍵
window.addEventListener("keydown", event => {
  if (document.activeElement.tagName === "INPUT" || document.activeElement.tagName === "TEXTAREA") return;
  if (event.key === "s" || event.key === "S") splitSelectedClip();
  if (event.key === "Delete") selectedClip() && deleteClip(selectedClip().id);
});

scrub.addEventListener("input", () => {
  stop();
  const t = Number(scrub.value);
  $("timeText").textContent = `${formatTime(t)} / ${formatTime(timelineDuration())}`;
  updatePlayhead(t);
  syncPreview(t);
});

wireLane(videoTrack, "video");
wireLane(audioTrack, "audio");
window.addEventListener("resize", fitMonitorFrame);
loadMedia();
