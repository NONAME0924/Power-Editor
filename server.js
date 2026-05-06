const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { pathToFileURL } = require("url");
const { spawn } = require("child_process");
const crypto = require("crypto");

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const MEDIA = path.join(ROOT, "media");
const EXPORTS = path.join(ROOT, "exports");
const PORT = Number(process.env.PORT || 5177);
const EDGE_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const FFPROBE_CANDIDATES = [
  process.env.FFPROBE,
  "ffprobe"
].filter(Boolean);
const PYTHON_CANDIDATES = [
  process.env.PYTHON,
  "python",
  "python3"
].filter(Boolean);

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

async function ensureDirs() {
  await fsp.mkdir(MEDIA, { recursive: true });
  await fsp.mkdir(EXPORTS, { recursive: true });
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  res.writeHead(status, { "content-type": type, "content-length": data.length });
  res.end(data);
}

function bad(res, status, message) {
  send(res, status, { error: message });
}

function safeName(name) {
  const ext = path.extname(name || "").toLowerCase().replace(/[^a-z0-9.]/g, "");
  const base = path.basename(name || "asset", ext).replace(/[^\w.-]+/g, "_").slice(0, 70) || "asset";
  return `${Date.now()}_${crypto.randomBytes(4).toString("hex")}_${base}${ext || ".bin"}`;
}

function jsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function pipeToFile(req, file) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file);
    req.pipe(out);
    req.on("error", reject);
    out.on("error", reject);
    out.on("finish", resolve);
  });
}

async function listMedia() {
  const files = await fsp.readdir(MEDIA, { withFileTypes: true });
  const items = files
    .filter(f => f.isFile() && !f.name.startsWith("."));
  return Promise.all(items.map(async f => {
      const ext = path.extname(f.name).toLowerCase();
      const type = [".mp4", ".mov", ".webm", ".mkv"].includes(ext) ? "video" : "audio";
      return { name: f.name, type, url: `/media/${encodeURIComponent(f.name)}`, ...(await probeMedia(path.join(MEDIA, f.name))) };
    }));
}

async function probeMedia(file) {
  const args = [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type,width,height",
    "-of", "json",
    file
  ];
  for (const command of FFPROBE_CANDIDATES) {
    try {
      const child = spawn(command, args, { cwd: ROOT, windowsHide: true });
      let stdout = "";
      child.stdout.on("data", d => { stdout += d.toString(); });
      await new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", code => code === 0 ? resolve() : reject(new Error(`ffprobe exited with ${code}`)));
      });
      const info = JSON.parse(stdout || "{}");
      return {
        duration: Number(info.format?.duration || 0) || 0,
        hasAudio: (info.streams || []).some(s => s.codec_type === "audio"),
        hasVideo: (info.streams || []).some(s => s.codec_type === "video"),
        width: Number((info.streams || []).find(s => s.codec_type === "video")?.width || 0),
        height: Number((info.streams || []).find(s => s.codec_type === "video")?.height || 0)
      };
    } catch {
      // Try the next ffprobe path.
    }
  }
  return { duration: 0, hasAudio: false, hasVideo: false, width: 0, height: 0 };
}

function wsMessage(headers, body = "") {
  return `${Object.entries(headers).map(([k, v]) => `${k}:${v}`).join("\r\n")}\r\n\r\n${body}`;
}

function ssml(text, voice, rate, pitch) {
  const escaped = String(text).replace(/[<>&'"]/g, ch => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", "\"": "&quot;" }[ch]));
  return `<speak version="1.0" xml:lang="zh-TW"><voice name="${voice}"><prosody rate="${rate}" pitch="${pitch}">${escaped}</prosody></voice></speak>`;
}

async function generateTts({ text, voice = "zh-TW-HsiaoChenNeural", rate = "+0%", pitch = "+0Hz" }) {
  if (!String(text || "").trim()) throw new Error("請輸入要轉成語音的文字。");

  const file = safeName("edge-tts.mp3");
  const outPath = path.join(MEDIA, file);
  const pythonErrors = [];

  for (const python of PYTHON_CANDIDATES) {
    try {
      await run(python, ["-m", "edge_tts", "--text", text, "--voice", voice, "--rate", rate, "--pitch", pitch, "--write-media", outPath]);
      return { name: file, type: "audio", url: `/media/${encodeURIComponent(file)}` };
    } catch (err) {
      pythonErrors.push(`${python}: ${err.message}`);
    }
  }

  const packageEntry = path.join(ROOT, "node_modules", "edge-tts", "out", "index.js");

  try {
    await fsp.access(packageEntry);
    const edge = await import(pathToFileURL(packageEntry).href);
    const audio = await edge.tts(text, { voice, rate, pitch });
    await fsp.writeFile(outPath, audio);
    return { name: file, type: "audio", url: `/media/${encodeURIComponent(file)}` };
  } catch (packageError) {
    if (!global.WebSocket) throw new Error(`Edge TTS 不可用。Python: ${pythonErrors.join(" | ")} Node: ${packageError.message}`);
  }

  const id = crypto.randomUUID().replace(/-/g, "");
  const audioChunks = [];
  const url = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${EDGE_TOKEN}&ConnectionId=${id}`;

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: {
        Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
        "User-Agent": "Mozilla/5.0"
      }
    });
    const timer = setTimeout(() => reject(new Error("Edge TTS 連線逾時。")), 30000);

    ws.binaryType = "arraybuffer";
    ws.addEventListener("open", () => {
      const timestamp = new Date().toISOString();
      ws.send(wsMessage({
        "X-Timestamp": timestamp,
        "Content-Type": "application/json; charset=utf-8",
        Path: "speech.config"
      }, JSON.stringify({ context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: false }, outputFormat: "audio-24khz-96kbitrate-mono-mp3" } } } })));
      ws.send(wsMessage({
        "X-RequestId": id,
        "X-Timestamp": timestamp,
        "Content-Type": "application/ssml+xml",
        Path: "ssml"
      }, ssml(text, voice, rate, pitch)));
    });
    ws.addEventListener("message", event => {
      if (typeof event.data === "string") {
        if (event.data.includes("Path:turn.end")) {
          clearTimeout(timer);
          ws.close();
          resolve();
        }
        return;
      }
      const buf = Buffer.from(event.data);
      const marker = Buffer.from("Path:audio\r\n\r\n");
      const idx = buf.indexOf(marker);
      if (idx >= 0) audioChunks.push(buf.subarray(idx + marker.length));
    });
    ws.addEventListener("error", () => reject(new Error(`Edge TTS 連線失敗，請確認網路可連到 Microsoft 語音服務。Python: ${pythonErrors.slice(-2).join(" | ")}`)));
  });

  if (!audioChunks.length) throw new Error("Edge TTS 沒有回傳音訊。");
  await fsp.writeFile(outPath, Buffer.concat(audioChunks));
  return { name: file, type: "audio", url: `/media/${encodeURIComponent(file)}` };
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, windowsHide: true });
    let stderr = "";
    child.stderr.on("data", d => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve(stderr);
      else reject(new Error(stderr || `${command} exited with ${code}`));
    });
  });
}

function mediaPath(name) {
  const full = path.resolve(MEDIA, path.basename(name));
  if (!full.startsWith(MEDIA)) throw new Error("Invalid media path.");
  return full;
}

function buildExport(timeline) {
  const video = [...(timeline.video || [])].sort((a, b) => a.start - b.start);
  const audio = [...(timeline.audio || [])].sort((a, b) => a.start - b.start);
  const duration = Math.max(1, Number(timeline.duration || 0), ...video.map(c => Number(c.start) + Number(c.duration)), ...audio.map(c => Number(c.start) + Number(c.duration)));
  const output = path.join(EXPORTS, `export_${new Date().toISOString().replace(/[:.]/g, "-")}.mp4`);
  const inputs = [];
  const all = [];
  let inputIndex = 0;
  for (const clip of video) {
    clip.input = inputIndex++;
    inputs.push("-i", mediaPath(clip.name));
    all.push(clip);
  }
  for (const clip of audio) {
    clip.input = inputIndex++;
    inputs.push("-i", mediaPath(clip.name));
    all.push(clip);
  }

  const filters = [`color=c=#111827:s=1280x720:r=30:d=${duration.toFixed(3)}[base]`];
  let lastVideo = "base";
  
  function getAtempoFilter(speed) {
    let s = speed;
    const chain = [];
    while (s > 2.0) { chain.push("atempo=2.0"); s /= 2.0; }
    while (s < 0.5) { chain.push("atempo=0.5"); s /= 0.5; }
    if (s !== 1.0) chain.push(`atempo=${s.toFixed(3)}`);
    return chain.join(",");
  }

  video.forEach((clip, i) => {
    const start = Number(clip.start || 0);
    const trimStart = Number(clip.offset || 0);
    const speed = Number(clip.speed || 1);
    const dur = Math.max(0.1, Number(clip.duration || 1));
    const sourceDur = dur * speed;
    
    let vFilter = `[${clip.input}:v]trim=start=${trimStart.toFixed(3)}:duration=${sourceDur.toFixed(3)},setpts=(1/${speed})*PTS-STARTPTS+${start.toFixed(3)}/TB,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}]`;
    filters.push(vFilter);
    filters.push(`[${lastVideo}][v${i}]overlay=shortest=0:eof_action=pass[tmpv${i}]`);
    lastVideo = `tmpv${i}`;
  });

  const audioLabels = [];
  video.forEach((clip, i) => {
    if (clip.useAudio === false || clip.hasAudio === false) return;
    const start = Math.round(Number(clip.start || 0) * 1000);
    const trimStart = Number(clip.offset || 0);
    const speed = Number(clip.speed || 1);
    const dur = Math.max(0.1, Number(clip.duration || 1));
    const sourceDur = dur * speed;
    const atempo = getAtempoFilter(speed);
    
    filters.push(`[${clip.input}:a]atrim=start=${trimStart.toFixed(3)}:duration=${sourceDur.toFixed(3)},asetpts=PTS-STARTPTS${atempo ? "," + atempo : ""},adelay=${start}|${start},volume=${Number(clip.volume ?? 1)}[va${i}]`);
    audioLabels.push(`[va${i}]`);
  });
  audio.forEach((clip, i) => {
    const start = Math.round(Number(clip.start || 0) * 1000);
    const trimStart = Number(clip.offset || 0);
    const speed = Number(clip.speed || 1);
    const dur = Math.max(0.1, Number(clip.duration || 1));
    const sourceDur = dur * speed;
    const atempo = getAtempoFilter(speed);
    
    filters.push(`[${clip.input}:a]atrim=start=${trimStart.toFixed(3)}:duration=${sourceDur.toFixed(3)},asetpts=PTS-STARTPTS${atempo ? "," + atempo : ""},adelay=${start}|${start},volume=${Number(clip.volume ?? 1)}[a${i}]`);
    audioLabels.push(`[a${i}]`);
  });

  if (audioLabels.length) filters.push(`${audioLabels.join("")}amix=inputs=${audioLabels.length}:duration=longest:normalize=0[aout]`);
  else filters.push(`anullsrc=channel_layout=stereo:sample_rate=44100:d=${duration.toFixed(3)}[aout]`);

  const args = [
    "-y",
    ...inputs,
    "-filter_complex", filters.join(";"),
    "-map", `[${lastVideo}]`,
    "-map", "[aout]",
    "-t", duration.toFixed(3),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    output
  ];
  return { args, output };
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "GET" && url.pathname === "/api/media") return send(res, 200, await listMedia());
  if (req.method === "POST" && url.pathname === "/api/upload") {
    const name = safeName(url.searchParams.get("name"));
    const file = path.join(MEDIA, name);
    await pipeToFile(req, file);
    const ext = path.extname(name).toLowerCase();
    return send(res, 200, { name, type: [".mp4", ".mov", ".webm", ".mkv"].includes(ext) ? "video" : "audio", url: `/media/${encodeURIComponent(name)}`, ...(await probeMedia(file)) });
  }
  if (req.method === "POST" && url.pathname === "/api/tts") {
    try {
      return send(res, 200, await generateTts(await jsonBody(req)));
    } catch (err) {
      return bad(res, 500, err.message);
    }
  }
  if (req.method === "POST" && url.pathname === "/api/export") {
    try {
      const { args, output } = buildExport(await jsonBody(req));
      await run("ffmpeg", args);
      return send(res, 200, { file: path.basename(output), url: `/exports/${encodeURIComponent(path.basename(output))}` });
    } catch (err) {
      return bad(res, 500, err.message.split("\n").slice(-8).join("\n"));
    }
  }

  const folder = url.pathname.startsWith("/media/") ? MEDIA : url.pathname.startsWith("/exports/") ? EXPORTS : PUBLIC;
  const rel = url.pathname.startsWith("/media/") || url.pathname.startsWith("/exports/") ? decodeURIComponent(url.pathname.split("/").pop()) : (url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1)));
  const file = path.resolve(folder, path.basename(rel));
  if (!file.startsWith(folder)) return bad(res, 403, "Forbidden");

  try {
    const stats = await fsp.stat(file);
    const contentType = mime[path.extname(file).toLowerCase()] || "application/octet-stream";
    
    // 支援影片與聲音的串流 (HTTP Range Requests)
    const range = req.headers.range;
    if (range && (contentType.startsWith("video/") || contentType.startsWith("audio/"))) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
      const chunksize = (end - start) + 1;
      const fileStream = fs.createReadStream(file, { start, end });
      const head = {
        "Content-Range": `bytes ${start}-${end}/${stats.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunksize,
        "Content-Type": contentType,
      };
      res.writeHead(206, head);
      fileStream.pipe(res);
    } else {
      const head = {
        "Content-Length": stats.size,
        "Content-Type": contentType,
      };
      res.writeHead(200, head);
      fs.createReadStream(file).pipe(res);
    }
    return;
  } catch (e) {
    return bad(res, 404, "Not found");
  }
}

ensureDirs().then(() => {
  http.createServer((req, res) => route(req, res).catch(err => bad(res, 500, err.message)))
    .listen(PORT, () => console.log(`Local Power Editor running at http://localhost:${PORT}`));
});
