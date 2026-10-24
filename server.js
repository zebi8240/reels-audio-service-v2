/**
 * reels-audio-service-v2  (SCRATCH BUILD - bilkul naya, purani service se alag)
 * Version 2.4.0
 * Diagnostic ("attempts" field) ke sath, ffprobe fix ke sath, aur aik naye
 * rescue tareeqay ke sath:
 * yt-dlp ko MP3 banate waqt ffmpeg ke SATH ffprobe bhi chahiye hota hai
 * (audio codec maloom karne ke liye). Sirf ffmpeg-static hone se kuch reels
 * "unable to obtain file audio codec with ffprobe" keh ke fail ho jati thin
 * jabke video download ho chuka hota tha. Is liye ab ffprobe-static bhi
 * install hota hai aur dono binary aik hi folder (ffmpeg-tools/) me rakh ke
 * wo folder yt-dlp ko diya jata hai. Phir bhi agar yt-dlp ki MP3 wali
 * postprocessing fail ho, to naya tareeqa 4 file ko seedha download kar ke
 * ffmpeg se khud MP3 banata hai (is me ffprobe ki zaroorat hi nahi) -
 * kyun ke download to kamyab ho raha tha, sirf MP3 banane wala qadam
 * atak raha tha. /health me ab ffmpeg-tools ki mojoodgi bhi nazar ati
 * hai taake Render pe ffprobe hai ya nahi, ye andaza na lagana pare.
 *
 * Free Instagram Reels -> MP3 microservice. Is build me koi paid API nahi hai.
 *
 * Audio nikaalne ke 4 tareeqay, bari bari:
 *   1) yt-dlp default
 *   2) yt-dlp explicit bestaudio format
 *   3) yt-dlp browser impersonation ke sath (--impersonate chrome)
 *   4) Instagram embed page se video ka seedha link nikaal ke ffmpeg se MP3
 * Instagram kabhi kabhi kisi reel pe pehle tareeqay rok deta hai, is liye
 * agla tareeqa khud lag jata hai. Isi liye kuch reels pehli service (v1) pe
 * fail hoti thin lekin yahan chal jati hain.
 *
 * Endpoints:
 *   GET  /                        -> standalone tool page (public/index.html)
 *   GET  /health                  -> { ok: true, version, ytdlp: true/false }
 *   GET  /api/audio?url=<instagram reel/post url>
 *   POST /api/audio               -> body JSON { url } ya { link }
 *     -> { success: true, audioUrl, downloadUrl, title, author, thumbnail, duration, source }
 *        audioUrl / downloadUrl temporary links hain (30 min baad auto-delete).
 *     -> { success: false, message } on failure
 */

const express = require('express');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const ffmpegPath = require('ffmpeg-static');
// ffprobe alag package se ata hai (ffmpeg-static me sirf ffmpeg hota hai).
// Agar package install na ho to null rehta hai aur purana tareeqa chalta hai.
let ffprobePath = null;
try { ffprobePath = require('ffprobe-static').path; } catch (e) { ffprobePath = null; }

// yt-dlp ko ffmpeg + ffprobe dono aik hi folder me chahiye hote hain.
// Dono binary ko ffmpeg-tools/ me copy kar ke wo folder diya jata hai.
const FFMPEG_TOOLS_DIR = path.join(__dirname, 'ffmpeg-tools');
function setupFfmpegTools() {
  try {
    fs.mkdirSync(FFMPEG_TOOLS_DIR, { recursive: true });
    const pairs = [];
    if (ffmpegPath) pairs.push([ffmpegPath, 'ffmpeg']);
    if (ffprobePath) pairs.push([ffprobePath, 'ffprobe']);
    for (const [src, name] of pairs) {
      const dest = path.join(FFMPEG_TOOLS_DIR, name);
      let needCopy = true;
      try {
        if (fs.existsSync(dest) && fs.statSync(dest).size === fs.statSync(src).size) needCopy = false;
      } catch (e) { /* phir copy kar do */ }
      if (needCopy) {
        fs.copyFileSync(src, dest);
        fs.chmodSync(dest, 0o755);
      }
    }
    console.log('[ffmpeg-tools] ready:', fs.readdirSync(FFMPEG_TOOLS_DIR).join(', '));
    return FFMPEG_TOOLS_DIR;
  } catch (e) {
    console.log('[ffmpeg-tools] setup failed, falling back to ffmpeg binary path:', e.message);
    return ffmpegPath;
  }
}
const FFMPEG_LOCATION = setupFfmpegTools();

const VERSION = '2.4.0';
const app = express();
app.set('trust proxy', 1); // Render proxy ke peeche https pehchanne ke liye
const PORT = process.env.PORT || 3000;
const YTDLP = path.join(__dirname, 'bin', 'yt-dlp');
const FILES_DIR = path.join(__dirname, 'files');
const FILE_TTL_MS = 30 * 60 * 1000; // download links expire after 30 minutes

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/json,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.instagram.com/',
};

fs.mkdirSync(FILES_DIR, { recursive: true });

app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/files', express.static(FILES_DIR));

// ---- simple CORS (taake tool kisi bhi site se call ho sake) ----
app.use('/api/', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---- simple in-memory rate limit: max 30 requests per minute per IP ----
const hits = {};
setInterval(() => { for (const k in hits) delete hits[k]; }, 60 * 1000);
app.use('/api/', (req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  hits[ip] = (hits[ip] || 0) + 1;
  if (hits[ip] > 30) return res.status(429).json({ success: false, message: 'Too many requests. Please slow down and try again in a minute.' });
  next();
});

app.get('/health', (req, res) => {
  let ffmpegTools = [];
  try { ffmpegTools = fs.readdirSync(FFMPEG_TOOLS_DIR); } catch (e) { ffmpegTools = []; }
  res.json({ ok: true, service: 'reels-audio-service-v2', version: VERSION, ytdlp: fs.existsSync(YTDLP), ffmpegTools, ffprobe: ffmpegTools.includes('ffprobe') });
});

// ---- Instagram URL helpers ----
function isInstagramUrl(u) {
  return /^https?:\/\/(www\.)?instagram\.com\//i.test(String(u || ''));
}
function getInputUrl(req) {
  return String((req.query && req.query.url) || (req.body && (req.body.url || req.body.link)) || '').trim();
}
function getShortcode(u) {
  const m = String(u || '').match(/instagram\.com\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/i);
  return m ? m[1] : null;
}

// ---- keep yt-dlp fresh: startup pe update check (non-blocking) ----
function updateYtDlp() {
  if (!fs.existsSync(YTDLP)) {
    console.log('[yt-dlp] binary not found. Run: node scripts/fetch-ytdlp.js');
    return;
  }
  execFile(YTDLP, ['-U'], { timeout: 90000 }, (err, stdout) => {
    const line = (stdout || '').trim().split('\n').pop();
    console.log('[yt-dlp] update check:', err ? String(err.message).slice(0, 120) : line);
  });
}

/* ================================================================
   Tareeqa 1-3: yt-dlp
   extraArgs har koshish ke liye alag hain.
   ================================================================ */
function tryExtractYtDlp(reelUrl, id, extraArgs) {
  return new Promise((resolve, reject) => {
    const outTemplate = path.join(FILES_DIR, `${id}.%(ext)s`);
    const args = [
      '-x',                      // extract audio only
      '--audio-format', 'mp3',
      '--audio-quality', '0',    // best quality
      '--ffmpeg-location', FFMPEG_LOCATION,
      '--no-playlist',
      '--socket-timeout', '30',
      '--retries', '3',
      '--print-json',            // title / author / thumbnail isi se milte hain
    ].concat(extraArgs, ['-o', outTemplate, reelUrl]);

    const child = spawn(YTDLP, args, { timeout: 180000 });
    let out = '';
    let errOut = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { errOut += d.toString(); });
    child.on('error', (e) => reject(new Error('spawn: ' + e.message)));
    child.on('close', (code) => {
      const files = fs.readdirSync(FILES_DIR).filter((f) => f.startsWith(id) && f.endsWith('.mp3'));
      if (code === 0 && files.length > 0) {
        let info = {};
        try { info = JSON.parse(out.trim().split('\n').pop()); } catch (e) { /* info na mile to khali chalega */ }
        return resolve({ file: files[0], info });
      }
      const tail = errOut.replace(/\s+/g, ' ').trim().slice(-200);
      console.error('[yt-dlp] attempt failed, code', code, tail);
      reject(new Error('yt-dlp code ' + code + (tail ? ': ' + tail : '')));
    });
  });
}

/* ================================================================
   Tareeqa 4 (naya rescue): yt-dlp se sirf download, MP3 khud ffmpeg se
   yt-dlp ki MP3 wali postprocessing ffprobe mangti hai; agar wo qadam
   atak jaye to bhi download kamyab hota hai. Is liye yahan -x bilkul
   nahi lagaya: file jesi hai wesi download hoti hai, phir seedha ffmpeg
   usay MP3 bana deta hai (is conversion me ffprobe ki zaroorat nahi).
   ================================================================ */
function tryExtractYtDlpDownload(reelUrl, id) {
  return new Promise((resolve, reject) => {
    const outTemplate = path.join(FILES_DIR, `${id}-dl.%(ext)s`);
    const args = [
      '-f', 'bestaudio/best',
      '--ffmpeg-location', FFMPEG_LOCATION,
      '--no-playlist',
      '--socket-timeout', '30',
      '--retries', '3',
      '--print-json',
      '-o', outTemplate, reelUrl,
    ];
    const child = spawn(YTDLP, args, { timeout: 180000 });
    let out = '';
    let errOut = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { errOut += d.toString(); });
    child.on('error', (e) => reject(new Error('spawn: ' + e.message)));
    child.on('close', async (code) => {
      const downloaded = fs.readdirSync(FILES_DIR).filter((f) => f.startsWith(`${id}-dl.`) && !f.endsWith('.mp3'));
      if (code === 0 && downloaded.length > 0) {
        const srcPath = path.join(FILES_DIR, downloaded[0]);
        const mp3Name = `${id}.mp3`;
        const mp3Path = path.join(FILES_DIR, mp3Name);
        try {
          await convertToMp3(srcPath, mp3Path);
          let info = {};
          try { info = JSON.parse(out.trim().split('\n').pop()); } catch (e) { /* info na mile to khali chalega */ }
          fs.unlink(srcPath, () => {});
          return resolve({ file: mp3Name, info });
        } catch (e) {
          fs.unlink(srcPath, () => {});
          return reject(new Error('yt-dlp-download convert failed: ' + e.message));
        }
      }
      const tail = errOut.replace(/\s+/g, ' ').trim().slice(-200);
      console.error('[yt-dlp-download] attempt failed, code', code, tail);
      reject(new Error('yt-dlp-download code ' + code + (tail ? ': ' + tail : '')));
    });
  });
}

/* ================================================================
   Tareeqa 5: Instagram embed page
   Public reel ka embed page (instagram.com/reel/<id>/embed) aksar us
   waqt bhi video ka seedha link deta hai jab aam extractor roka jaye.
   Wahan se MP4 la ke ffmpeg se MP3 banta hai.
   ================================================================ */
function fetchText(url, redirectsLeft) {
  if (redirectsLeft === undefined) redirectsLeft = 5;
  return new Promise((resolve, reject) => {
    https.get(url, { headers: BROWSER_HEADERS, timeout: 30000 }, (resp) => {
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location && redirectsLeft > 0) {
        resp.resume();
        return fetchText(resp.headers.location, redirectsLeft - 1).then(resolve, reject);
      }
      if (resp.statusCode !== 200) {
        resp.resume();
        return reject(new Error('embed page HTTP ' + resp.statusCode));
      }
      let body = '';
      resp.on('data', (d) => { body += d; });
      resp.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

function downloadFile(url, dest, redirectsLeft) {
  if (redirectsLeft === undefined) redirectsLeft = 5;
  return new Promise((resolve, reject) => {
    https.get(url, { headers: BROWSER_HEADERS, timeout: 120000 }, (resp) => {
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location && redirectsLeft > 0) {
        resp.resume();
        return downloadFile(resp.headers.location, dest, redirectsLeft - 1).then(resolve, reject);
      }
      if (resp.statusCode !== 200) {
        resp.resume();
        return reject(new Error('video download HTTP ' + resp.statusCode));
      }
      const ws = fs.createWriteStream(dest);
      resp.pipe(ws);
      ws.on('finish', () => ws.close(() => resolve(dest)));
      ws.on('error', reject);
    }).on('error', reject);
  });
}

function unescapeJsonString(s) {
  try { return JSON.parse('"' + s.replace(/"/g, '\\"') + '"'); } catch (e) { /* neeche wala seedha tareeqa */ }
  return String(s).replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/\\u003d/g, '=');
}
function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

// Embed ke HTML me se video ka seedha (MP4) link dhoondna - kai mashhoor shaklein try hoti hain
function findVideoUrl(html) {
  const patterns = [
    /"video_url":"((?:[^"\\]|\\.)*)"/,
    /"contentUrl":"((?:[^"\\]|\\.)*?\.mp4(?:[^"\\]|\\.)*)"/,
    /property="og:video(?::secure_url)?" content="([^"]+)"/,
    /content="([^"]+)" property="og:video(?::secure_url)?"/,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) {
      const u = unescapeJsonString(m[1]);
      if (/^https?:\/\//i.test(u) && (u.includes('.mp4') || u.includes('cdninstagram') || u.includes('fbcdn'))) return u;
    }
  }
  return null;
}
function findMeta(html, prop) {
  let m = html.match(new RegExp('property="' + prop + '" content="([^"]*)"'));
  if (!m) m = html.match(new RegExp('content="([^"]*)" property="' + prop + '"'));
  return m ? decodeEntities(m[1]) : '';
}

function convertToMp3(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-y', '-i', inputPath, '-vn', '-codec:a', 'libmp3lame', '-q:a', '0', outputPath], { timeout: 180000 });
    let errOut = '';
    child.stderr.on('data', (d) => { errOut += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000) return resolve();
      console.error('[ffmpeg] convert failed, code', code, errOut.slice(-200));
      reject(new Error('ffmpeg convert failed'));
    });
  });
}

async function tryExtractEmbed(reelUrl, id) {
  const code = getShortcode(reelUrl);
  if (!code) throw new Error('embed: no shortcode in url');
  let html = null;
  let lastErr = null;
  for (const suffix of ['embed/captioned/', 'embed/']) {
    try { html = await fetchText(`https://www.instagram.com/reel/${code}/${suffix}`); break; }
    catch (e) { lastErr = e; }
  }
  if (!html) throw lastErr || new Error('embed: page not fetched');
  const videoUrl = findVideoUrl(html);
  if (!videoUrl) throw new Error('embed: no video url found');
  const mp4Path = path.join(FILES_DIR, `${id}-embed.mp4`);
  const mp3Name = `${id}.mp3`;
  const mp3Path = path.join(FILES_DIR, mp3Name);
  await downloadFile(videoUrl, mp4Path);
  try {
    await convertToMp3(mp4Path, mp3Path);
  } finally {
    fs.unlink(mp4Path, () => {});
  }
  return {
    file: mp3Name,
    info: {
      title: findMeta(html, 'og:title'),
      uploader: '',
      thumbnail: findMeta(html, 'og:image'),
      duration: null,
    },
  };
}

function cleanupPartial(id) {
  fs.readdirSync(FILES_DIR)
    .filter((f) => f.startsWith(id))
    .forEach((f) => fs.unlink(path.join(FILES_DIR, f), () => {}));
}

async function handleAudio(req, res) {
  const reelUrl = getInputUrl(req);
  if (!isInstagramUrl(reelUrl)) {
    return res.status(400).json({ success: false, message: 'Please provide a valid Instagram URL.' });
  }
  if (!fs.existsSync(YTDLP)) {
    return res.status(500).json({ success: false, message: 'Audio engine not installed yet. Try again in a minute.' });
  }

  const id = crypto.randomBytes(8).toString('hex');

  const attempts = [
    { name: 'yt-dlp', run: () => tryExtractYtDlp(reelUrl, id, []) },
    { name: 'yt-dlp-bestaudio', run: () => tryExtractYtDlp(reelUrl, id, ['-f', 'bestaudio/best']) },
    { name: 'yt-dlp-impersonate', run: () => tryExtractYtDlp(reelUrl, id, ['--impersonate', 'chrome']) },
    { name: 'yt-dlp-download', run: () => tryExtractYtDlpDownload(reelUrl, id) },
    { name: 'embed', run: () => tryExtractEmbed(reelUrl, id) },
  ];

  const attemptErrors = [];
  for (let i = 0; i < attempts.length; i++) {
    try {
      const { file, info } = await attempts[i].run();
      const fileUrl = `${req.protocol}://${req.get('host')}/files/${file}`;
      setTimeout(() => fs.unlink(path.join(FILES_DIR, file), () => {}), FILE_TTL_MS);
      return res.json({
        success: true,
        audioUrl: fileUrl,
        downloadUrl: fileUrl,
        title: info.title || info.description || '',
        author: info.uploader || info.channel || '',
        thumbnail: info.thumbnail || '',
        duration: info.duration || null,
        source: attempts[i].name,
      });
    } catch (e) {
      console.error('[audio] attempt', attempts[i].name, 'failed:', e.message);
      attemptErrors.push({ attempt: attempts[i].name, error: String(e.message).slice(0, 300) });
      cleanupPartial(id);
    }
  }

  return res.status(500).json({
    success: false,
    message: 'Could not extract audio from this link. It may be private, removed, or Instagram is busy right now. Please try another public reel.',
    attempts: attemptErrors,
  });
}
app.get('/api/audio', handleAudio);
app.post('/api/audio', handleAudio);

// ---- background cleanup: 30 min se purani files delete (har 10 min) ----
setInterval(() => {
  const now = Date.now();
  fs.readdirSync(FILES_DIR).forEach((f) => {
    if (f === '.gitkeep') return;
    const p = path.join(FILES_DIR, f);
    fs.stat(p, (e, st) => {
      if (!e && now - st.mtimeMs > FILE_TTL_MS) fs.unlink(p, () => {});
    });
  });
}, 10 * 60 * 1000);

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`reels-audio-service-v2 v${VERSION} listening on port ${PORT}`);
    updateYtDlp();
  });
}

module.exports = { findVideoUrl };
