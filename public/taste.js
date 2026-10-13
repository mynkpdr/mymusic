// Browser-side taste profile and ranking. Pure functions only (no DOM, no network) so they run unchanged in the page and in Node tests.
const DAY = 864e5;
const HALF_LIFE_DAYS = 30; // older listening counts for half as much every 30 days
export const MAX_EVENTS = 2000;

// words that appear in nearly every music upload title and say nothing about taste
const STOP = new Set(('official video audio lyrical lyrics lyric full song songs music hd 4k 8k video videos new latest the and for with from feat ft song version original ' +
  'out now track watch live best top hits hit playlist mix jukebox album movie film studio vevo records entertainment records topic channel subscribe').split(' '));

/** @typedef {{t:number,id:string,c?:string,n?:string,d?:number,p?:number,k:'p'|'l'|'u'|'a'|'d'}} TasteEvent */

export const artistsOf = (sub) => [...new Set(String(sub ?? '').toLowerCase().split(/,|&|;|\bfeat\.?\b|\bft\.?\b|\bx\b|\band\b/).map((x) => x.trim()).filter((x) => x.length > 1))];
export function tokens(title) {
  const clean = String(title ?? '').toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
  // \p{M}: vowel signs in Hindi/Tamil/... are marks, not letters, and would otherwise split words apart
  return [...new Set((clean.match(/[\p{L}\p{M}\p{N}]+/gu) ?? []).filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !STOP.has(w)))];
}
export const durSec = (text) => String(text ?? '').split(':').reduce((a, x) => a * 60 + (+x || 0), 0);
const decay = (t, now) => 0.5 ** (Math.max(0, now - t) / (HALF_LIFE_DAYS * DAY));

/** How strongly one event says "I like this" (positive) or "I don't" (negative). */
export function eventWeight(e) {
  switch (e.k) {
    case 'l': return 2;
    case 'u': return -2;
    case 'a': return 1.5;
    case 'd': return 1.2;
    case 'p': {
      const p = e.p ?? 0, frac = e.d ? Math.min(1, p / e.d) : 0.5;
      if (p < 5) return 0; // accidental tap
      if (frac >= 0.8 || p >= 180) return 1; // finished it, or sat through a long one
      if (frac < 0.2 && p < 30) return -0.6; // skipped almost immediately
      return 0.2 + 0.8 * frac;
    }
    default: return 0;
  }
}

/**
 * Turns the event log into per-artist, per-keyword and per-video affinities.
 * @param {TasteEvent[]} events
 * @param {{v?:Record<string,string>,c?:Record<string,number>}} hidden videos/channels the user said "not interested" to
 */
export function buildProfile(events, hidden = {}, now = Date.now()) {
  const ch = new Map(), kw = new Map(), ids = new Map();
  let positives = 0;
  for (const e of events) {
    const base = eventWeight(e);
    if (!base) continue;
    const w = base * decay(e.t, now);
    if (base > 0) positives++;
    for (const a of artistsOf(e.c)) ch.set(a, (ch.get(a) ?? 0) + w);
    for (const tk of tokens(e.n)) kw.set(tk, (kw.get(tk) ?? 0) + w * 0.5);
    const s = ids.get(e.id) ?? { w: 0, done: false, last: 0, skipped: false };
    s.w += w; s.last = Math.max(s.last, e.t);
    if (e.k === 'p' && base >= 1) s.done = true;
    if (e.k === 'p' && base < 0) s.skipped = true;
    ids.set(e.id, s);
  }
  const top = (m) => Math.max(1, ...m.values());
  return { ch, kw, ids, positives, chMax: top(ch), kwMax: top(kw), hiddenV: new Set(Object.keys(hidden.v ?? {})), hiddenC: new Set(Object.keys(hidden.c ?? {})) };
}
export const isCold = (prof) => prof.positives < 1;

/** Picks what to ask YouTube about: a few liked/replayed videos (weighted random so refreshes differ) and the top artists. */
export function pickSeeds(events, prof, { videos = 5, channels = 2, now = Date.now(), rng = Math.random } = {}) {
  const byId = new Map();
  for (const e of events) {
    const w = eventWeight(e) * decay(e.t, now);
    if (w <= 0) continue;
    const s = byId.get(e.id) ?? { id: e.id, title: e.n, sub: e.c, w: 0 };
    s.w += w; byId.set(e.id, s);
  }
  const pool = [...byId.values()], picked = [];
  while (picked.length < videos && pool.length) {
    const total = pool.reduce((a, s) => a + s.w ** 1.5, 0);
    let r = rng() * total, i = 0;
    for (; i < pool.length - 1; i++) { r -= pool[i].w ** 1.5; if (r <= 0) break; }
    picked.push(pool.splice(i, 1)[0]);
  }
  const topArtists = [...prof.ch].filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1]).slice(0, channels).map(([a]) => a);
  return { videos: picked, channels: topArtists };
}

const normTitle = (t) => String(t ?? '').toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, '').replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
function freshness(age) {
  const m = /^(\d+)\s?(y|mo|w|d|h|m)\b/.exec(String(age ?? ''));
  if (!m) return 0;
  return m[2] === 'y' && +m[1] >= 3 ? -0.2 : m[2] === 'y' ? 0 : 0.2;
}
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/** Score one candidate and say why. `c.hits` = how many of your seed videos' related lists contained it. */
export function scoreCandidate(c, prof, now = Date.now()) {
  const arts = artistsOf(c.sub);
  const chAff = arts.length ? Math.max(...arts.map((a) => clamp((prof.ch.get(a) ?? 0) / prof.chMax, -1, 1))) : 0;
  const tk = tokens(c.title);
  const kwAff = tk.length ? clamp(tk.reduce((a, t) => a + Math.max(0, prof.kw.get(t) ?? 0) / prof.kwMax, 0) / Math.sqrt(tk.length), 0, 1) : 0;
  const seedBoost = (Math.min(3, c.hits ?? 1) - 1) * 0.5;
  let penalty = 0;
  const seen = prof.ids.get(c.id);
  if (seen) penalty -= seen.done ? (now - seen.last < 21 * DAY ? 3 : 1.5) : seen.skipped ? 1.5 : 0.5;
  const dur = durSec(c.duration);
  if (dur > 20 * 60) penalty -= 0.6; // hour-long mixes crowd out songs
  const parts = { channel: 1.6 * chAff, keywords: kwAff, related: seedBoost, fresh: freshness(c.age) };
  const score = parts.channel + parts.keywords + parts.related + parts.fresh + penalty;
  const lead = Object.entries(parts).sort((a, b) => b[1] - a[1])[0];
  return { score, chAff, why: lead[1] > 0.25 ? lead[0] : 'related' };
}

/**
 * Ranks candidates: drops hidden/duplicate ones, scores, then picks greedily with a per-artist
 * diversity penalty and a periodic "explore" slot (something unfamiliar that several seeds agree on).
 */
export function rank(cands, prof, { n = 25, exclude = new Set(), now = Date.now(), rng = Math.random, exploreEvery = 5 } = {}) {
  const seenTitle = new Set(), pool = [];
  for (const c of cands) {
    if (!c.id || exclude.has(c.id) || prof.hiddenV.has(c.id)) continue;
    const arts = artistsOf(c.sub);
    if (arts.some((a) => prof.hiddenC.has(a))) continue;
    const nt = normTitle(c.title);
    if (nt && seenTitle.has(nt)) continue;
    seenTitle.add(nt);
    pool.push({ ...c, ...scoreCandidate(c, prof, now), jitter: (rng() - 0.5) * 0.3, first: arts[0] ?? '' });
  }
  const out = [], used = new Map();
  while (out.length < n && pool.length) {
    const explore = exploreEvery > 0 && (out.length + 1) % exploreEvery === 0;
    const pick = (only) => {
      let best = -1, bestV = -Infinity;
      for (let i = 0; i < pool.length; i++) {
        const p = pool[i];
        if (only && !only(p)) continue;
        const v = p.score + p.jitter - 0.8 * (used.get(p.first) ?? 0);
        if (v > bestV) { bestV = v; best = i; }
      }
      return best;
    };
    let best = explore ? pick((p) => p.chAff <= 0.1) : -1;
    const exploring = best >= 0;
    if (!exploring) best = pick(); // no unfamiliar candidate left: use the best normal one so the list is never short
    if (best < 0) break;
    const [p] = pool.splice(best, 1);
    used.set(p.first, (used.get(p.first) ?? 0) + 1);
    out.push(exploring ? { ...p, why: 'explore' } : p);
  }
  return out;
}

/** Human-readable reason shown under a recommended video. */
export function reasonText(c) {
  if (c.why === 'channel' && c.first) return `You listen to ${c.first.replace(/\b\w/g, (x) => x.toUpperCase())}`;
  if ((c.hits ?? 1) >= 2) return `Related to ${c.hits} songs you played`;
  if (c.why === 'explore') return 'Something new for you';
  if (c.via) return `Because you played “${String(c.via).slice(0, 34)}”`;
  return 'Based on your listening';
}

// ---------- backup / transfer ----------
export const BACKUP_VERSION = 1;
export const BACKUP_KEYS = ['settings', 'likes', 'playlists', 'history', 'plays', 'downloads', 'searches', 'eq', 'tune', 'shuffle', 'repeat', 'taste_events', 'taste_hidden'];

/** Returns an error message, or null when `b` looks like a backup this app wrote. */
export function validateBackup(b) {
  if (!b || typeof b !== 'object') return 'This is not a mymusic backup file';
  if (b.app !== 'ymusic-web') return 'This is not a mymusic backup file';
  if (!Number.isInteger(b.version) || b.version > BACKUP_VERSION) return 'This backup was made by a newer version of the app';
  const d = b.data;
  if (!d || typeof d !== 'object') return 'The backup has no data';
  for (const k of ['likes', 'history', 'downloads', 'searches', 'taste_events']) if (d[k] !== undefined && !Array.isArray(d[k])) return `Backup field "${k}" is damaged`;
  for (const k of ['playlists', 'plays', 'settings', 'taste_hidden']) if (d[k] !== undefined && (typeof d[k] !== 'object' || Array.isArray(d[k]) || d[k] === null)) return `Backup field "${k}" is damaged`;
  const bad = (d.taste_events ?? []).find((e) => typeof e?.id !== 'string' || typeof e?.t !== 'number' || !['p', 'l', 'u', 'a', 'd'].includes(e?.k));
  return bad ? 'Some listening events in the backup are damaged' : null;
}

const unionBy = (a, b, key, cap) => { const seen = new Set(a.map(key)); return [...a, ...b.filter((x) => !seen.has(key(x)))].slice(0, cap); };

/** mode "merge": keep everything on this device and add what is new from the backup. mode "replace": the backup wins. */
export function mergeBackup(local, incoming, mode) {
  if (mode === 'replace') return { ...incoming };
  const out = { ...local };
  out.likes = unionBy(local.likes ?? [], incoming.likes ?? [], (t) => t.id, 5000);
  out.history = unionBy(local.history ?? [], incoming.history ?? [], (t) => t.id, 200);
  out.downloads = unionBy(local.downloads ?? [], incoming.downloads ?? [], (t) => t.id, 500);
  out.searches = unionBy(local.searches ?? [], incoming.searches ?? [], (q) => q, 20);
  out.playlists = { ...(local.playlists ?? {}) };
  for (const [name, tracks] of Object.entries(incoming.playlists ?? {})) out.playlists[name] = unionBy(out.playlists[name] ?? [], tracks, (t) => t.id, 5000);
  out.plays = { ...(local.plays ?? {}) };
  for (const [id, p] of Object.entries(incoming.plays ?? {})) out.plays[id] = { ...(out.plays[id] ?? p), n: Math.max(out.plays[id]?.n ?? 0, p.n ?? 0) };
  const evKey = (e) => `${e.t}:${e.id}:${e.k}`;
  out.taste_events = unionBy(local.taste_events ?? [], incoming.taste_events ?? [], evKey, Infinity).sort((a, b) => a.t - b.t).slice(-MAX_EVENTS);
  out.taste_hidden = { v: { ...(incoming.taste_hidden?.v ?? {}), ...(local.taste_hidden?.v ?? {}) }, c: { ...(incoming.taste_hidden?.c ?? {}), ...(local.taste_hidden?.c ?? {}) } };
  return out; // settings, eq, tune, shuffle and repeat stay as they are on this device
}
