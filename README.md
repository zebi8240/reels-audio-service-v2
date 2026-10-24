# reels-audio-service-v2 (scratch build)

Free Instagram Reels -> MP3 microservice. Node/Express + yt-dlp + ffmpeg-static.
**No paid API at all** — no RapidAPI in this build. This service is completely
separate from the old `reels-audio-service` (v1); deploying this does not
change v1 or reelsaudiodownloader.in.

## Endpoints
- `GET /` — standalone tool page
- `GET /health` — `{ ok: true, service: "reels-audio-service-v2", ytdlp: true }`
- `GET /api/audio?url=<instagram url>` and `POST /api/audio` `{ "url": "..." }`
  - Success: `{ success: true, audioUrl, downloadUrl, title, author, thumbnail, duration }`
  - MP3 files are served from `/files/...` and auto-deleted after 30 minutes.

## Deploy on Render (free)
1. Push this folder to a NEW GitHub repo, e.g. `reels-audio-service-v2`.
2. Render -> New -> Web Service -> connect the new repo.
3. Plan: **Free**. Build command: `npm install && npm run fetch-ytdlp`
   Start command: `npm start`
   (render.yaml in this folder already carries these settings if you use Blueprint.)
4. After deploy, open `https://<your-service>.onrender.com/health` — it must show `ytdlp: true`.
5. If Render adds a suffix to the service name (like it did with `-wq00` for
   TikTok), note the real URL — the WordPress plugin has ONE line to change.

## Notes
- Only public Instagram reels/posts work. Private links cannot be fetched
  without a login, and this service uses no login/cookies on purpose.
- Instagram sometimes blocks datacenter IPs. When that happens the API returns
  a clean error instead of hanging; a later retry often works.
- Do NOT add an UptimeRobot keep-awake monitor for this service until the
  Render free-hours math is checked for the month (750 free instance-hours
  per workspace). Without a monitor it sleeps when idle and the first request
  takes 1-3 minutes to wake up.
