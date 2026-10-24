/**
 * Downloads the standalone yt-dlp binary (Linux, no Python needed)
 * if it is missing or older than 7 days.
 * Used by Render's build step and locally via: npm run fetch-ytdlp
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const BIN_DIR = path.join(__dirname, '..', 'bin');
const BIN = path.join(BIN_DIR, 'yt-dlp');
const URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'reels-audio-service-v2' } }, (res) => {
      // follow the GitHub release redirect
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return download(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error('Download failed, HTTP ' + res.statusCode));
      }
      const ws = fs.createWriteStream(BIN);
      res.pipe(ws);
      ws.on('finish', () => {
        fs.chmodSync(BIN, 0o755);
        resolve();
      });
      ws.on('error', reject);
    }).on('error', reject);
  });
}

async function main() {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  try {
    const st = fs.statSync(BIN);
    if (Date.now() - st.mtimeMs < MAX_AGE_MS) {
      console.log('yt-dlp binary is fresh, skipping download.');
      return;
    }
    console.log('yt-dlp binary is old, re-downloading...');
  } catch (e) {
    console.log('yt-dlp binary missing, downloading...');
  }
  await download(URL);
  console.log('yt-dlp downloaded to', BIN);
  try {
    const v = execSync(`"${BIN}" --version`).toString().trim();
    console.log('yt-dlp version:', v);
  } catch (e) {
    console.log('(could not print version, but binary is in place)');
  }
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
