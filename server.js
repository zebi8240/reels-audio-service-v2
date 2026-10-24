/**
 * reels-audio-service-v2  (SCRATCH BUILD - bilkul naya, purani service se alag)
 * Free Instagram Reels -> MP3 microservice (yt-dlp + ffmpeg).
 * Is build me koi paid API nahi hai - RapidAPI bhi nahi. Sirf yt-dlp.
 *
 * Endpoints:
 *   GET  /                        -> standalone tool page (public/index.html)
 *   GET  /health                  -> { ok: true, ytdlp: true/false }
 *   GET  /api/audio?url=<instagram reel/post url>
 *   POST /api/audio               -> body JSON { url } ya { link }
 *     -> { success: true, audioUrl, downloadUrl, title, author, thumbnail, duration }
 *        audioUrl / downloadUrl temporary links hain (30 min baad auto-delete).
 *     -> { success: false, message } on failure
 */

const express = require('express');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ffmpegPath = require('ffmpeg-static');

const app = express();
app.set('trust proxy', 1); // Render proxy ke peeche https pehchanne ke liye
const PORT = process.env.PORT || 3000;
const YTDLP = path.join(__dirname, 'bin', 'yt-dlp');
const FILES_DIR = path.join(__dirname, 'files');
const FILE_TTL_MS = 30 * 60 * 1000; // download links expire after 30 minutes

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

app.get('/health', (req, res) => res.json({ ok: true, service: 'reels-audio-service-v2', ytdlp: fs.existsSync(YTDLP) }));

// ---- Instagram URL check: sirf instagram.com links allow ----
function isInstagramUrl(u) {
  return /^https?:\/\/(www\.)?instagram\.com\//i.test(String(u || ''));
}
function getInputUrl(req) {
  return String((req.query && req.query.url) || (req.body && (req.body.url || req.body.link)) || '').trim();
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

/**
 * Ek koshish: diye gaye extra format args ke sath audio extract karo.
 * Kamyaabi par { file, info } milega, warna reject.
 */
function tryExtract(reelUrl, id, extraArgs) {
  return new Promise((resolve, reject) => {
    const outTemplate = path.join(FILES_DIR, `${id}.%(ext)s`);
    const args = [
      '-x',                      // extract audio only
      '--audio-format', 'mp3',
      '--audio-quality', '0',    // best quality
      '--ffmpeg-location', ffmpegPath,
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
      console.error('[yt-dlp] attempt failed, code', code, errOut.slice(-300));
      reject(new Error('yt-dlp failed with code ' + code));
    });
  });
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

  // Koshish 1: default best audio. Koshish 2 (agar pehli fail ho): explicit bestaudio format.
  const attempts = [[], ['-f', 'bestaudio/best']];
  for (let i = 0; i < attempts.length; i++) {
    try {
      const { file, info } = await tryExtract(reelUrl, id, attempts[i]);
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
      });
    } catch (e) {
      console.error('[audio] attempt', i + 1, 'failed:', e.message);
      cleanupPartial(id);
    }
  }

  return res.status(500).json({
    success: false,
    message: 'Could not extract audio from this link. It may be private, removed, or Instagram is busy right now. Please try another public reel.',
  });
}
app.get('/api/audio', handleAudio);
app.post('/api/audio', handleAudio);

// ---- background cleanup: 30 min se purani MP3 files delete (har 10 min) ----
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

app.listen(PORT, () => {
  console.log(`reels-audio-service-v2 listening on port ${PORT}`);
  updateYtDlp();
});
