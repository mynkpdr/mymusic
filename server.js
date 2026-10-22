import express from 'express';
import rateLimit from 'express-rate-limit';
import { Innertube, Platform } from 'youtubei.js';
import { mintPoToken } from './pot.js';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';

// Deployment settings (all optional): see README.md
const env = process.env;
const PORT = env.PORT || 8999;
const HOST = env.HOST || '0.0.0.0';
const num = (k, d) => (env[k] === undefined ? d : Number(env[k]));
const DOWNLOADS = env.DISABLE_DOWNLOADS !== '1';
const MAX_DOWNLOADS = num('MAX_DOWNLOADS', 3);           // simultaneous downloads / ffmpeg jobs
const MAX_DOWNLOAD_SECONDS = num('MAX_DOWNLOAD_MINUTES', 30) * 60; // longest video that can be downloaded
const SB_API = 'https://sponsor.ajay.app/api/skipSegments';
const dir = path.dirname(fileURLToPath(import.meta.url));

Platform.shim.eval = async (data) => new Function(data.output)();
const yt = await Innertube.create();
const app = express();
if (env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(env.TRUST_PROXY) ? +env.TRUST_PROXY : env.TRUST_PROXY); // set when behind nginx/Caddy/Cloudflare so limits count real client IPs
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'SAMEORIGIN',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' https://i.ytimg.com data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
  });
  next();
});
const aboutPage = (await fs.readFile(path.join(dir, 'public', 'about.html'), 'utf8')).replace('{{CONTACT}}', env.CONTACT_EMAIL ? `<a href="mailto:${env.CONTACT_EMAIL}">${env.CONTACT_EMAIL}</a>` : 'see the address listed where you found this site');
app.get('/about.html', (_req, res) => res.type('html').send(aboutPage));
app.use(express.static(path.join(dir, 'public')));
app.get('/watch', (_req, res) => res.sendFile(path.join(dir, 'public', 'index.html'))); // YouTube-style links: the page reads ?v= and plays it
app.get('/favicon.ico', (_req, res) => res.sendStatus(204));

// ---- normalizers -------------------------------------------------------
const txt = (x) => (x == null ? '' : typeof x === 'string' ? x : x.text ?? '');
const thumbOf = (it) => {
  const arr = it.thumbnail?.contents ?? it.thumbnail ?? it.thumbnails ?? [];
  const last = Array.isArray(arr) ? arr[arr.length - 1] : null;
  return (last?.url ?? '').replace(/=w\d+-h\d+/, '=w400-h400');
};
const names = (xs) => (Array.isArray(xs) ? xs.map((a) => a.name).filter(Boolean).join(', ') : '');

// music videos can carry a browse id ("MPED...") as id; the playable id lives on the endpoint
const videoIdOf = (it) => {
  const id = it.id ?? it.video_id;
  return id && !/^MPED/.test(id) ? id : it.endpoint?.payload?.videoId ?? id;
};
function norm(it) {
  const kind = it.item_type ?? it.type;
  const browseId = it.endpoint?.payload?.browseId;
  const out = { kind, thumb: thumbOf(it) };
  switch (kind) {
    case 'song': case 'video': case 'non_music_track': case 'PlaylistPanelVideo':
      return { ...out, kind: kind === 'PlaylistPanelVideo' ? 'song' : kind, id: videoIdOf(it), title: txt(it.title),
        sub: names(it.artists) || names(it.authors) || txt(it.author) || txt(it.subtitle)
          || subFromColumn(it), album: txt(it.album?.name),
        duration: txt(it.duration), durationSec: it.duration?.seconds ?? 0 };
    case 'album': case 'playlist': case 'endpoint':
      return { ...out, kind: kind === 'endpoint' ? (browseId?.startsWith('MPRE') ? 'album' : 'playlist') : kind,
        id: browseId ?? it.id, title: txt(it.title), sub: txt(it.subtitle) || it.author?.name || '' };
    case 'artist':
      return { ...out, id: it.id ?? browseId, title: it.name ?? txt(it.title), sub: txt(it.subscribers) || txt(it.subtitle) };
    default:
      return null;
  }
}
const TYPE_WORDS = new Set(['Song', 'Video', 'Single', 'Album', 'EP', 'Playlist']);
function subFromColumn(it) {
  const parts = txt(it.flex_columns?.[1]?.title).split(' • ');
  const rest = TYPE_WORDS.has(parts[0]) ? parts.slice(1) : parts;
  return rest.find((x) => !/^\d+:\d\d/.test(x)) ?? '';
}
// regular YouTube search results (the Android app is a YouTube client: videos carry channel, views and age)
const yThumb = (id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
function normY(it) {
  switch (it.type) {
    case 'Video':
      return { kind: 'video', id: it.id, title: txt(it.title), sub: it.author?.name ?? '', channelId: it.author?.id, views: txt(it.short_view_count) || txt(it.view_count), age: txt(it.published), duration: txt(it.duration), thumb: yThumb(it.id) };
    case 'Channel':
      return { kind: 'channel', id: it.id ?? it.author?.id, title: it.author?.name ?? txt(it.title), sub: txt(it.subscriber_count) || txt(it.video_count) || txt(it.subscribers), thumb: (it.author?.thumbnails?.[0]?.url ?? '').replace(/^\/\//, 'https://') };
    case 'LockupView': {
      const rows = (it.metadata?.metadata?.metadata_rows ?? []).map((r) => (r.metadata_parts ?? []).map((x) => txt(x.text)).filter(Boolean).join(' · ')).filter(Boolean);
      if (it.content_type === 'VIDEO') return { kind: 'video', id: it.content_id, title: txt(it.metadata?.title), sub: '', views: rows[0] ?? '', age: '', duration: '', thumb: yThumb(it.content_id) };
      return { kind: 'playlist', id: it.content_id, title: txt(it.metadata?.title), sub: rows[0] ?? '', thumb: it.content_image?.primary_thumbnail?.image?.[0]?.url ?? '' };
    }
    default:
      return null;
  }
}
const normAll = (xs) => (xs ?? []).map(norm).filter((x) => x?.id);

// ---- stream resolution --------------------------------------------------
// One lookup per video: all adaptive formats are kept so the download dialog can offer every quality.
const videos = new Map(); // id -> { exp, title, author, duration, formats, pot, urls }
const inflight = new Map();
function loadVideo(id) {
  const hit = videos.get(id);
  if (hit && hit.exp > Date.now()) return Promise.resolve(hit);
  if (!inflight.has(id)) inflight.set(id, fetchVideo(id).finally(() => inflight.delete(id)));
  return inflight.get(id);
}
async function fetchVideo(id) {
  let info = await yt.getBasicInfo(id, { client: 'YTMUSIC' });
  if (info.playability_status?.status !== 'OK') info = await yt.getBasicInfo(id, { client: 'MWEB' }); // YTMUSIC only serves music-catalog videos; plain uploads need MWEB (WEB has no direct URLs, IOS/ANDROID_VR streams cut at ~1MB)
  if (info.playability_status?.status !== 'OK') throw new Error(info.playability_status?.reason ?? 'unplayable');
  const entry = { exp: Date.now() + 3 * 3600e3, title: info.basic_info.title, author: info.basic_info.author ?? '', duration: info.basic_info.duration ?? 0,
    formats: info.streaming_data.adaptive_formats, pot: null, urls: new Map() };
  videos.set(id, entry);
  if (videos.size > 200) videos.delete(videos.keys().next().value);
  return entry;
}
// googlevideo cuts the stream after ~1MB unless the URL carries a PO token bound to the video id
const urlFor = (id, e, f) => {
  if (!e.urls.has(f.itag)) e.urls.set(f.itag, (async () => `${await f.decipher(yt.session.player)}&pot=${encodeURIComponent(await (e.pot ??= mintPoToken(id)))}`)());
  return e.urls.get(f.itag);
};
const isAudio = (f) => f.has_audio && !f.has_video;
const isVideo = (f) => f.has_video && !f.has_audio;
const byBitrate = (a, b) => b.bitrate - a.bitrate;
const bestAudio = (e, mime = 'audio/mp4') => e.formats.filter((f) => isAudio(f) && f.mime_type.startsWith(mime)).sort(byBitrate)[0];
const mp4Video = (e) => e.formats.filter((f) => isVideo(f) && f.mime_type.startsWith('video/mp4'));
const sizeOf = (f, e) => f.content_length ?? Math.round((f.bitrate / 8) * e.duration);
const safeName = (n) => n.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 150) || 'video';

async function resolve(id, video, mime) {
  const e = await loadVideo(id);
  // playback video is the best <=720p mp4 video-only track; the page plays it muted in sync with the audio track
  const f = video ? mp4Video(e).filter((x) => x.height <= 720).sort((a, b) => b.height - a.height)[0] : (mime && bestAudio(e, mime)) || bestAudio(e); // Opus (~170 kbps) when the browser asked for it and the video has it, else AAC (~130 kbps)
  if (!f) throw new Error('no suitable format');
  return { url: await urlFor(id, e, f), size: sizeOf(f, e), mime: f.mime_type.split(';')[0] };
}

// googlevideo answers 403 to open-ended or >~10MB ranges, so every upstream request is a bounded chunk
const CHUNK = 4 * 1024 * 1024;
const upstream = (url, start, end) => fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
const drain = (sink) => new Promise((r) => sink.once('drain', r));

async function feed(url, size, sink, res) {
  for (let pos = 0; pos < size; pos += CHUNK) {
    if (res.destroyed) return;
    const up = await upstream(url, pos, Math.min(pos + CHUNK, size) - 1);
    if (!up.ok) throw new Error(`upstream ${up.status}`);
    for await (const part of Readable.fromWeb(up.body)) if (!sink.write(part)) await drain(sink);
  }
  sink.end();
}

async function proxy(req, res, id, video, mime) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  const start = m?.[1] ? +m[1] : 0;
  let s, end, up;
  for (const attempt of [1, 2]) { // a cached stream URL can go stale: on a refusal, look the video up again once
    s = await resolve(id, video, mime);
    end = Math.min(m?.[2] ? +m[2] : Infinity, start + CHUNK - 1, s.size - 1);
    if (start >= s.size) return res.status(416).set('Content-Range', `bytes */${s.size}`).end();
    up = await upstream(s.url, start, end);
    if (up.ok) break;
    videos.delete(id);
    if (attempt === 2) return res.status(502).json({ error: `upstream ${up.status}` });
  }
  res.status(206).set({ 'Content-Type': s.mime, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${s.size}` });
  Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
}

// Download options: native M4A/WebM audio, MP3 re-encode at a chosen bitrate, or MP4 video merged with the best audio.
function encoder(res, args, stdio = ['pipe', 'pipe', 'inherit']) {
  const ff = spawn('ffmpeg', ['-loglevel', 'error', ...args], { stdio });
  ff.stdout.pipe(res);
  ff.on('error', () => res.destroy());
  for (const st of ff.stdio.slice(3)) st.on('error', () => res.destroy());
  res.on('close', () => { ff.kill('SIGKILL'); }); // client left: never leave an encoder running
  return ff;
}
let activeDownloads = 0;
async function download(req, res, id) {
  const e = await loadVideo(id), { fmt = 'm4a', itag, name } = req.query;
  const refusal = downloadRefusal(e);
  if (refusal) return res.status(refusal[0]).json({ error: refusal[1] });
  activeDownloads++; res.on('close', () => activeDownloads--);
  const base = encodeURIComponent(safeName(name || e.title));
  const head = (type, ext, size) => {
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${base}.${ext}`);
    if (size) res.setHeader('Content-Length', size);
  };
  try {
    if (fmt === 'mp4') {
      const v = itag ? e.formats.find((f) => f.itag === +itag) : mp4Video(e).sort((a, b) => b.height - a.height)[0], a = bestAudio(e);
      if (!v || !a || !isVideo(v)) return res.status(400).json({ error: 'format not available' });
      const [vu, au] = await Promise.all([urlFor(id, e, v), urlFor(id, e, a)]);
      const ff = encoder(res, ['-i', 'pipe:3', '-i', 'pipe:4', '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'], ['ignore', 'pipe', 'inherit', 'pipe', 'pipe']);
      head('video/mp4', 'mp4');
      return void await Promise.all([feed(vu, sizeOf(v, e), ff.stdio[3], res), feed(au, sizeOf(a, e), ff.stdio[4], res)]);
    }
    if (fmt === 'mp3') {
      const a = bestAudio(e), kbps = Math.min(320, Math.max(64, +req.query.kbps || 192));
      if (!a) return res.status(400).json({ error: 'format not available' });
      const ff = encoder(res, ['-i', 'pipe:0', '-vn', '-codec:a', 'libmp3lame', '-b:a', `${kbps}k`, '-f', 'mp3', 'pipe:1']);
      head('audio/mpeg', 'mp3');
      return void await feed(await urlFor(id, e, a), sizeOf(a, e), ff.stdin, res);
    }
    const a = itag ? e.formats.find((f) => f.itag === +itag) : bestAudio(e);
    if (!a || !isAudio(a)) return res.status(400).json({ error: 'format not available' });
    head(a.mime_type.split(';')[0], a.mime_type.startsWith('audio/webm') ? 'webm' : 'm4a', sizeOf(a, e));
    await feed(await urlFor(id, e, a), sizeOf(a, e), res, res);
  } catch (err) {
    videos.delete(id);
    if (res.headersSent) res.destroy(); else res.status(502).json({ error: err.message });
  }
}

// ---- routes ------------------------------------------------------------
const api = express.Router();
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => res.status(500).json({ error: e.message }));

api.get('/search', wrap(async (req, res) => {
  const { q, type } = req.query;
  if (!q) return res.status(400).json({ error: 'q required' });
  const r = await yt.music.search(q, type ? { type } : undefined);
  const flat = (r.contents ?? []).flatMap((c) => c.contents ?? []);
  res.json(normAll(flat));
}));

const searches = new Map(); // continuation handles for paged YouTube search
api.get('/ysearch', wrap(async (req, res) => {
  const { q, type, next } = req.query;
  let page;
  if (next) {
    const prev = searches.get(next);
    if (!prev) return res.status(410).json({ error: 'search expired' });
    page = await prev.getContinuation();
  } else {
    if (!q) return res.status(400).json({ error: 'q required' });
    page = await yt.search(q, type ? { type } : undefined);
  }
  const items = (page.results ?? []).map(normY).filter((x) => x?.id);
  let token = null;
  if (page.has_continuation) { token = Math.random().toString(36).slice(2); searches.set(token, page); if (searches.size > 200) searches.delete(searches.keys().next().value); }
  res.json({ items, next: token });
}));

api.get('/channel', wrap(async (req, res) => {
  const c = await yt.getChannel(req.query.id);
  const vids = await c.getVideos();
  res.json({ title: txt(c.metadata?.title), sub: txt(c.metadata?.description).slice(0, 120), thumb: c.metadata?.avatar?.[0]?.url ?? '',
    items: (vids.videos ?? []).map(normY).filter((x) => x?.id) });
}));

api.get('/suggest', wrap(async (req, res) => {
  const r = await yt.music.getSearchSuggestions(req.query.q ?? '');
  res.json((r[0]?.contents ?? []).map((x) => txt(x.suggestion)).filter(Boolean));
}));

api.get('/home', wrap(async (_req, res) => {
  const [home, explore] = await Promise.all([yt.music.getHomeFeed(), yt.music.getExplore()]);
  const shelves = [...(explore.sections ?? []), ...(home.sections ?? [])]
    .filter((s) => s.contents?.length)
    .map((s) => ({ title: txt(s.header?.title ?? s.title), items: normAll(s.contents) }))
    .filter((s) => s.title && s.items.length);
  res.json(shelves);
}));

api.get('/upnext', wrap(async (req, res) => {
  const r = await yt.music.getUpNext(req.query.v);
  res.json(normAll(r.contents));
}));

api.get('/album', wrap(async (req, res) => {
  const a = await yt.music.getAlbum(req.query.id);
  res.json({ title: txt(a.header?.title), sub: txt(a.header?.subtitle), thumb: thumbOf(a.header ?? {}),
    tracks: normAll(a.contents).map((t) => ({ ...t, sub: t.sub || txt(a.header?.strapline_text_one), thumb: t.thumb || thumbOf(a.header ?? {}) })) });
}));

api.get('/playlist', wrap(async (req, res) => {
  const p = await yt.music.getPlaylist(req.query.id);
  res.json({ title: txt(p.header?.title), sub: txt(p.header?.subtitle), thumb: thumbOf(p.header ?? {}), tracks: normAll(p.items) });
}));

api.get('/artist', wrap(async (req, res) => {
  const a = await yt.music.getArtist(req.query.id);
  res.json({ title: txt(a.header?.title), sub: txt(a.header?.subscription_button?.subscriber_count ?? a.header?.subtitle),
    thumb: thumbOf(a.header ?? {}),
    shelves: (a.sections ?? []).filter((s) => (s.contents ?? s.items)?.length)
      .map((s) => ({ title: txt(s.header?.title ?? s.title), items: normAll(s.contents ?? s.items) })).filter((s) => s.items.length) });
}));

api.get('/video', wrap(async (req, res) => {
  const id = req.query.id;
  const [info, cm] = await Promise.all([yt.getBasicInfo(id), yt.getComments(id).catch(() => null)]);
  const b = info.basic_info;
  res.json({ id, title: b.title, channel: b.author, channelId: b.channel_id, views: b.view_count, description: (b.short_description ?? '').slice(0, 2000),
    comments: (cm?.contents ?? []).slice(0, 20).map((t) => ({ author: txt(t.comment?.author?.name), text: txt(t.comment?.content), likes: txt(t.comment?.like_count), age: txt(t.comment?.published_time) })) });
}));

api.get('/segments', wrap(async (req, res) => {
  const u = `${SB_API}?videoID=${encodeURIComponent(req.query.v)}&categories=${encodeURIComponent('["music_offtopic","sponsor","intro","outro"]')}`;
  const r = await fetch(u);
  res.json(r.ok ? (await r.json()).map((s) => s.segment) : []);
}));

const IMG_HOSTS = /^(?:[a-z0-9-]+\.)*(?:ytimg\.com|googleusercontent\.com|ggpht\.com)$/;
api.get('/img', wrap(async (req, res) => {
  const u = new URL(req.query.u);
  if (u.protocol !== 'https:' || !IMG_HOSTS.test(u.hostname)) return res.status(400).json({ error: 'host not allowed' });
  const up = await fetch(u);
  if (!up.ok || !up.headers.get('content-type')?.startsWith('image/')) return res.status(404).end();
  res.set({ 'Content-Type': up.headers.get('content-type'), 'Cache-Control': 'public, max-age=86400' });
  res.send(Buffer.from(await up.arrayBuffer()));
}));

api.get('/stream/:id', wrap((req, res) => proxy(req, res, req.params.id, req.query.video === '1', req.query.fmt === 'webm' ? 'audio/webm' : undefined)));
api.get('/download/:id', wrap((req, res) => download(req, res, req.params.id)));

// what the download dialog lists: every audio format, MP3 bitrates, and one MP4 per resolution (with its merged size)
// The page calls this before starting a download, so these refusals reach the user as a message (the download itself runs in a hidden iframe).
const downloadRefusal = (e) => (!DOWNLOADS ? [403, 'Downloads are turned off on this site. Saving YouTube videos can break YouTube\'s terms and copyright law, and converting them is heavy on the server. You can still stream everything.']
  : e.duration > MAX_DOWNLOAD_SECONDS ? [413, `Videos longer than ${MAX_DOWNLOAD_SECONDS / 60} minutes can't be downloaded here`]
  : activeDownloads >= MAX_DOWNLOADS ? [429, 'The server is busy with other downloads, try again in a minute'] : null);
api.get('/formats/:id', wrap(async (req, res) => {
  const e = await loadVideo(req.params.id), a = bestAudio(e), refusal = downloadRefusal(e);
  if (refusal) return res.status(refusal[0]).json({ error: refusal[1] });
  const codec = (f) => (/codecs="([^"]+)"/.exec(f.mime_type)?.[1] ?? '').split('.')[0];
  const audio = e.formats.filter(isAudio).sort(byBitrate).map((f) => ({ itag: f.itag, ext: f.mime_type.startsWith('audio/webm') ? 'webm' : 'm4a',
    codec: { mp4a: 'AAC', opus: 'Opus' }[codec(f)] ?? codec(f), kbps: Math.round(f.bitrate / 1000), size: sizeOf(f, e) }));
  const mp3 = [128, 192, 256, 320].map((kbps) => ({ kbps, size: Math.round(e.duration * kbps * 125) }));
  const best = new Map();
  for (const f of mp4Video(e)) if (!best.has(f.height) || f.bitrate > best.get(f.height).bitrate) best.set(f.height, f);
  const video = [...best.values()].sort((x, y) => y.height - x.height).map((f) => ({ itag: f.itag, height: f.height, fps: f.fps, size: sizeOf(f, e) + (a ? sizeOf(a, e) : 0) }));
  res.json({ id: req.params.id, title: e.title, author: e.author, duration: e.duration, audio, mp3, video });
}));

const limit = (limit, opts = {}) => rateLimit({ windowMs: 60e3, limit, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many requests, slow down' }, ...opts });
const heavy = /^\/(stream|download|img)\//; // each has its own, separate limit
api.get('/config', (_req, res) => res.json({ downloads: DOWNLOADS, maxDownloadMinutes: MAX_DOWNLOAD_SECONDS / 60 }));

// Health: can we still resolve and sign a stream? (YouTube changes break this first.) Cached for 5 minutes.
let health = { at: 0, ok: false, error: 'not checked yet' };
api.get('/health', async (_req, res) => {
  if (Date.now() - health.at > 300e3) {
    try { const e = await loadVideo('dQw4w9WgXcQ'); await urlFor('dQw4w9WgXcQ', e, bestAudio(e)); health = { at: Date.now(), ok: true }; }
    catch (err) { health = { at: Date.now(), ok: false, error: err.message }; }
  }
  res.status(health.ok ? 200 : 503).json(health);
});

app.use('/api/stream', limit(num('STREAM_LIMIT_PER_MIN', 600)));
app.use('/api/download', limit(num('DOWNLOAD_LIMIT_PER_MIN', 6)));
app.use('/api/img', limit(num('IMG_LIMIT_PER_MIN', 600)));
app.use('/api', limit(num('API_LIMIT_PER_MIN', 180), { skip: (req) => heavy.test(req.path + '/') }));
app.use('/api', api);
app.listen(PORT, HOST, () => console.log(`http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`));
