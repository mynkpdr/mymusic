# mymusic

A web music player for YouTube, built with Node.js. Search, play videos as audio (with an optional video view), queue,
playlists, SponsorBlock skipping, an equalizer, and recommendations that learn from your listening **in your browser only**.
Your data can be exported and imported to move between devices.

> **Read this first.** mymusic uses YouTube through unofficial interfaces: it resolves and proxies streams and can
> save videos. That is against YouTube's Terms of Service and may infringe copyright depending on how it is used.
> It is shared for learning and personal use, with no affiliation to or endorsement by YouTube or Google.
> If you run a public instance you are responsible for it. See [Before making it public](#before-making-it-public).

## Features

- Search videos, channels and playlists; open `/watch?v=<id>[&t=<seconds>]` links to play straight away
- Queue with drag-and-drop, playlists, likes, history, sleep timer, speed and pitch, 5-band equalizer
- Opus audio (about 172 kbps) when the browser supports it, AAC otherwise
- Recommendations from your plays, likes and skips, stored only in local storage; export, import or reset them
- Download as M4A/WebM, MP3 (128 to 320 kbps) or MP4 (needs `ffmpeg`; can be switched off)
- Keyboard shortcuts (press `?`), installable as a PWA, light and dark themes
- Rate limits, download caps and a health endpoint for running it on the internet

## Run

Requires Node 22+ and `ffmpeg` on the PATH (MP3 and MP4 downloads).

```
npm install
npm start        # http://localhost:8999
npm test         # unit tests for the recommendation engine
```

Docker (needs no local Node or ffmpeg):

```
docker build -t mymusic .
docker run -p 8999:8999 -e DISABLE_DOWNLOADS=1 mymusic
```

Open `/watch?v=<video id>[&t=<seconds>]` to play a video straight away.

## Settings (environment variables, all optional)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT`, `HOST` | `8999`, `0.0.0.0` | Where to listen |
| `TRUST_PROXY` | off | Set to the number of proxies (e.g. `1`) or `loopback` when behind nginx/Caddy/Cloudflare, so rate limits use real client IPs |
| `API_LIMIT_PER_MIN` | `180` | Per-IP requests per minute for search, browse and the like |
| `STREAM_LIMIT_PER_MIN` | `600` | Per-IP stream requests per minute |
| `IMG_LIMIT_PER_MIN` | `600` | Per-IP image-proxy requests per minute |
| `DOWNLOAD_LIMIT_PER_MIN` | `6` | Per-IP download requests per minute |
| `DISABLE_DOWNLOADS` | off | Set to `1` to turn all downloads off |
| `MAX_DOWNLOADS` | `3` | Downloads / ffmpeg jobs running at once |
| `MAX_DOWNLOAD_MINUTES` | `30` | Longest video that can be downloaded |
| `CONTACT_EMAIL` | none | Shown on `/about.html` for takedown requests. **Set this before going public.** |

`GET /api/health` returns 200 when the server can still resolve and sign a YouTube stream, 503 otherwise
(cached 5 minutes). Point an uptime monitor at it.

## Before making it public

- This app uses YouTube without permission from YouTube (unofficial endpoints, stream proxying, downloads).
  That conflicts with YouTube's Terms of Service and can expose the operator to takedowns, IP blocks or worse.
  Get proper legal advice, or keep it private / invite-only (e.g. behind a login or VPN).
- Run behind HTTPS (Caddy, nginx, Cloudflare) and set `TRUST_PROXY`.
- Consider `DISABLE_DOWNLOADS=1`: downloads are the costliest and riskiest feature.
- Data-centre IP addresses are often blocked by YouTube; expect outages and watch `/api/health`.
- Icons and artwork in `public/assets` are original (generated). `public/assets/ui-icons.json` holds the UI's vector icons,
  which come from the Android Material icon set (Apache-2.0).
- Third-party licenses: `public/licenses.html`. Regenerate it if dependencies change.

## Layout

- `server.js`: Express API (search, browse, stream proxy, downloads, health). `pot.js`: BotGuard PO token for streams.
- `public/index.html`: the whole UI. `public/taste.js`: recommendation engine (pure, unit tested).
- Your data (likes, playlists, history, taste profile) lives only in the browser's local storage.
  Settings → Backup & transfer exports and imports it.

## Contributing

Issues and pull requests are welcome. Keep changes small, run `npm test` first, and do not add features that
depend on YouTube accounts or cookies.

## License

[MIT](LICENSE). Third-party software and fonts are listed in `public/licenses.html`.
