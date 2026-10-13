// Mints YouTube PO tokens (BotGuard) in-process; googlevideo cuts streams after ~1MB without one.
import { BotGuardClient } from 'bgutils-js/botguard';
import { buildURL, parseLooseJSON, getHeaders, USER_AGENT } from 'bgutils-js/utils';
import { WebPoMinter } from 'bgutils-js/webpo';
import { JSDOM } from 'jsdom';

const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';
let minter, expires = 0, pending;

async function build() {
  const dom = new JSDOM('<!DOCTYPE html><html lang="en"><head><title></title></head><body></body></html>', {
    url: 'https://www.youtube.com', referrer: 'https://www.youtube.com/', userAgent: USER_AGENT,
  });
  const page = await (await fetch('https://www.youtube.com', { headers: { accept: '*/*', 'accept-language': 'en-US,en;q=0.7', 'user-agent': USER_AGENT } })).text();
  const ytcfg = page.match(/ytcfg\.set\(({.+?})\);/s)?.[1];
  const attest = page.match(/window\.ytAtN\(\s*({[\s\S]*?})\s*\)/)?.[1];
  if (!ytcfg || !attest) throw new Error('PO token: challenge not found in youtube.com HTML');
  dom.window.yt = { config_: JSON.parse(ytcfg) };
  Object.assign(globalThis, { yt: dom.window.yt, window: dom.window, document: dom.window.document, location: dom.window.location, origin: dom.window.origin });
  if (!('navigator' in globalThis)) Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator });
  const challenge = parseLooseJSON(attest).R.bgChallenge;
  if (!challenge) throw new Error('PO token: no bgChallenge');
  const vm = await (await fetch(`https:${challenge.interpreterUrl.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue}`)).text();
  new Function(vm)();
  const client = await BotGuardClient.create({ program: challenge.program, globalName: challenge.globalName, globalObject: globalThis });
  const webPoSignalOutput = [];
  const snapshot = await client.snapshot({ webPoSignalOutput });
  const res = await fetch(buildURL('GenerateIT', true), { method: 'POST', headers: getHeaders(), body: JSON.stringify([REQUEST_KEY, snapshot]) });
  const [integrityToken, ttl, mintRefreshThreshold, websafeFallbackToken] = await res.json();
  minter = await WebPoMinter.create({ integrityToken, estimatedTtlSecs: ttl, mintRefreshThreshold, websafeFallbackToken }, webPoSignalOutput);
  expires = Date.now() + (ttl - 600) * 1000;
}

export async function mintPoToken(contentBinding) {
  if (!minter || Date.now() > expires) await (pending ??= build().finally(() => (pending = null)));
  return minter.mintAsWebsafeString(contentBinding);
}
