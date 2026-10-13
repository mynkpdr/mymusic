import test from 'node:test';
import assert from 'node:assert/strict';
import { tokens, artistsOf, eventWeight, buildProfile, isCold, pickSeeds, scoreCandidate, rank, reasonText, validateBackup, mergeBackup, durSec, MAX_EVENTS } from '../public/taste.js';

const NOW = Date.UTC(2026, 9, 13), DAY = 864e5;
const play = (id, c, n, p, d, daysAgo = 1) => ({ t: NOW - daysAgo * DAY, id, c, n, p, d, k: 'p' });
const cand = (id, sub, title, extra = {}) => ({ id, sub, title, hits: 1, ...extra });
const seq = (...v) => { let i = 0; return () => v[i++ % v.length]; }; // deterministic rng

test('tokens drop noise words, numbers and bracketed text', () => {
  assert.deepEqual(tokens('Arijit Singh - Tum Hi Ho (Official Video) [4K] 2013'), ['arijit', 'singh', 'tum']);
  assert.deepEqual(tokens('कहानी Suno Suno'), ['कहानी', 'suno']);
});
test('artistsOf splits featured artists', () => {
  assert.deepEqual(artistsOf('Daft Punk, Pharrell Williams & Nile Rodgers'), ['daft punk', 'pharrell williams', 'nile rodgers']);
  assert.deepEqual(artistsOf(''), []);
});
test('durSec parses clock text', () => { assert.equal(durSec('4:09'), 249); assert.equal(durSec('1:02:03'), 3723); assert.equal(durSec(undefined), 0); });

test('event weights: finish > partial > accidental > early skip', () => {
  assert.equal(eventWeight({ k: 'p', p: 200, d: 240 }), 1);
  assert.ok(eventWeight({ k: 'p', p: 100, d: 240 }) > 0.2 && eventWeight({ k: 'p', p: 100, d: 240 }) < 1);
  assert.equal(eventWeight({ k: 'p', p: 2, d: 240 }), 0);
  assert.equal(eventWeight({ k: 'p', p: 10, d: 240 }), -0.6);
  assert.equal(eventWeight({ k: 'l' }), 2); assert.equal(eventWeight({ k: 'u' }), -2);
});

test('empty history is a cold start', () => { assert.ok(isCold(buildProfile([], {}, NOW))); });

test('older listening counts for less (30 day half life)', () => {
  const fresh = buildProfile([play('a', 'Artist', 'Song', 200, 200, 0)], {}, NOW).ch.get('artist');
  const old = buildProfile([play('a', 'Artist', 'Song', 200, 200, 30)], {}, NOW).ch.get('artist');
  assert.ok(Math.abs(old - fresh / 2) < 1e-9);
});

const history = [
  ...[1, 2, 3, 4].map((i) => play('fav' + i, 'Arijit Singh', `Arijit song ${i}`, 220, 230, i)),
  ...[1, 2].map((i) => play('skip' + i, 'Loud Band', `Loud track ${i}`, 8, 200, i)),
  { t: NOW - DAY, id: 'liked', c: 'Arijit Singh', n: 'Liked one', k: 'l' },
];
const prof = buildProfile(history, { v: { bad: 'x' }, c: { 'banned artist': 1 } }, NOW);

test('profile prefers played artists and penalises skipped ones', () => {
  assert.ok(prof.ch.get('arijit singh') > 3);
  assert.ok(prof.ch.get('loud band') < 0);
});

test('ranking: liked artist first, skipped artist last, finished videos pushed down', () => {
  const out = rank([
    cand('n1', 'Loud Band', 'Loud track 9'), cand('n2', 'Arijit Singh', 'Arijit new song'), cand('n3', 'Someone Else', 'Neutral tune'),
    cand('fav1', 'Arijit Singh', 'Arijit song 1'),
  ], prof, { n: 10, now: NOW, rng: () => 0.5, exploreEvery: 0 });
  const ids = out.map((c) => c.id);
  assert.equal(ids[0], 'n2');
  assert.ok(ids.indexOf('loud') === -1);
  assert.ok(ids.indexOf('n1') > ids.indexOf('n3'), 'skipped artist ranks below a neutral one');
  assert.ok(ids.indexOf('fav1') > ids.indexOf('n3'), 'already finished video ranks below a fresh neutral one');
});

test('hidden videos, hidden channels, duplicates and excluded ids are dropped', () => {
  const ids = rank([
    cand('bad', 'Fine', 'x'), cand('b2', 'Banned Artist', 'y'), cand('d1', 'A', 'Same Title (Official Video)'), cand('d2', 'B', 'Same title [HD]'), cand('ex', 'C', 'z'), cand('ok', 'D', 'w'),
  ], prof, { n: 10, exclude: new Set(['ex']), now: NOW, rng: () => 0.5, exploreEvery: 0 }).map((c) => c.id);
  assert.deepEqual(ids.sort(), ['d1', 'ok']);
});

test('diversity: one artist cannot fill the whole top of the list', () => {
  const cands = [...Array(8)].map((_, i) => cand('a' + i, 'Arijit Singh', 'Brand new arijit track ' + i)).concat([...Array(4)].map((_, i) => cand('o' + i, 'Other ' + i, 'Other tune ' + i, { hits: 2 })));
  const top5 = rank(cands, prof, { n: 5, now: NOW, rng: () => 0.5, exploreEvery: 0 });
  assert.ok(top5.filter((c) => c.sub === 'Arijit Singh').length <= 4);
  assert.ok(top5.some((c) => c.sub !== 'Arijit Singh'));
});

test('explore slot (every 5th) picks something outside your usual artists, and the list is never short', () => {
  const ev = ['A', 'B', 'C', 'D', 'E', 'F'].map((a, i) => play('p' + i, 'Artist ' + a, 'Song ' + a, 200, 200, 1));
  const pr = buildProfile(ev, {}, NOW);
  const cands = ['A', 'B', 'C', 'D', 'E', 'F'].map((a) => cand('f' + a, 'Artist ' + a, 'New song ' + a)).concat([cand('s1', 'Stranger One', 'Unknown tune one'), cand('s2', 'Stranger Two', 'Unknown tune two')]);
  const out = rank(cands, pr, { n: 8, now: NOW, rng: () => 0.5, exploreEvery: 5 });
  assert.equal(out.length, 8);
  assert.equal(out[4].why, 'explore');
  assert.ok(out[4].id.startsWith('s'));
  // with nothing unfamiliar left, the explore slot falls back to the best normal candidate
  const only = rank(cands.slice(0, 6), pr, { n: 6, now: NOW, rng: () => 0.5, exploreEvery: 5 });
  assert.equal(only.length, 6);
});

test('seeds: only positive videos, top artists by affinity, weighted random respects rng', () => {
  const s = pickSeeds(history, prof, { videos: 3, channels: 1, now: NOW, rng: seq(0.1, 0.9, 0.5) });
  assert.equal(s.videos.length, 3);
  assert.ok(s.videos.every((v) => !v.id.startsWith('skip')));
  assert.deepEqual(s.channels, ['arijit singh']);
});

test('reason text', () => {
  assert.match(reasonText({ why: 'channel', first: 'arijit singh' }), /Arijit Singh/);
  assert.match(reasonText({ hits: 3 }), /3 songs/);
  assert.match(reasonText({ via: 'Tum Hi Ho' }), /Tum Hi Ho/);
});

// ---- backup ----
const wrap = (data) => ({ app: 'ymusic-web', version: 1, data });
test('validateBackup accepts good files and rejects damaged ones', () => {
  assert.equal(validateBackup(wrap({ likes: [], playlists: {}, taste_events: [{ id: 'a', t: 1, k: 'p' }] })), null);
  assert.match(validateBackup(null), /not a mymusic/);
  assert.match(validateBackup({ app: 'other', version: 1, data: {} }), /not a mymusic/);
  assert.match(validateBackup({ app: 'ymusic-web', version: 99, data: {} }), /newer/);
  assert.match(validateBackup(wrap({ likes: 'x' })), /likes/);
  assert.match(validateBackup(wrap({ playlists: [] })), /playlists/);
  assert.match(validateBackup(wrap({ taste_events: [{ id: 5, t: 1, k: 'p' }] })), /damaged/);
  assert.match(validateBackup(wrap({ taste_events: [{ id: 'a', t: 1, k: 'zzz' }] })), /damaged/);
});

test('merge keeps local data, adds new items, dedupes, and never touches settings', () => {
  const local = { settings: { theme: 'dark' }, likes: [{ id: 'a' }], playlists: { Mix: [{ id: 'a' }] }, history: [{ id: 'h1' }], plays: { a: { id: 'a', n: 2 } }, downloads: [], searches: ['x'],
    taste_events: [{ t: 2, id: 'a', k: 'p', p: 100 }], taste_hidden: { v: { z: 'Z' }, c: {} } };
  const inc = { settings: { theme: 'light' }, likes: [{ id: 'a' }, { id: 'b' }], playlists: { Mix: [{ id: 'b' }], New: [{ id: 'c' }] }, history: [{ id: 'h1' }, { id: 'h2' }], plays: { a: { id: 'a', n: 5 }, b: { id: 'b', n: 1 } },
    downloads: [{ id: 'd' }], searches: ['x', 'y'], taste_events: [{ t: 1, id: 'b', k: 'l' }, { t: 2, id: 'a', k: 'p', p: 100 }], taste_hidden: { v: { q: 'Q' }, c: { evil: 1 } } };
  const m = mergeBackup(local, inc, 'merge');
  assert.deepEqual(m.settings, { theme: 'dark' });
  assert.deepEqual(m.likes.map((x) => x.id), ['a', 'b']);
  assert.deepEqual(m.playlists.Mix.map((x) => x.id), ['a', 'b']); assert.deepEqual(m.playlists.New.map((x) => x.id), ['c']);
  assert.deepEqual(m.history.map((x) => x.id), ['h1', 'h2']);
  assert.equal(m.plays.a.n, 5); assert.equal(m.plays.b.n, 1);
  assert.deepEqual(m.searches, ['x', 'y']);
  assert.deepEqual(m.taste_events.map((e) => e.t), [1, 2]);
  assert.deepEqual(Object.keys(m.taste_hidden.v).sort(), ['q', 'z']); assert.deepEqual(m.taste_hidden.c, { evil: 1 });
  assert.deepEqual(mergeBackup(local, inc, 'replace').settings, { theme: 'light' });
});

test('event log is capped when merging', () => {
  const many = [...Array(MAX_EVENTS + 50)].map((_, i) => ({ t: i, id: 'v' + i, k: 'p', p: 50 }));
  assert.equal(mergeBackup({ taste_events: [] }, { taste_events: many }, 'merge').taste_events.length, MAX_EVENTS);
});
