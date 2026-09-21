'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const REFERER = 'https://vidlink.pro/';
const ORIGIN  = 'https://vidlink.pro';
const UA      = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124';

// ── WASM singleton (survives warm invocations) ────────────────────────────────
let wasmReady = false;
let bootPromise = null;

function bootWasm() {
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    globalThis.window = globalThis;
    globalThis.self = globalThis;
    globalThis.document = { createElement: () => ({}), body: { appendChild: () => {} } };

    const sodium = require('libsodium-wrappers');
    await sodium.ready;
    globalThis.sodium = sodium;

    eval(fs.readFileSync(path.join(__dirname, 'script.js'), 'utf8'));

    const go = new Dm();
    const wasmBuf = fs.readFileSync(path.join(__dirname, 'fu.wasm'));
    const { instance } = await WebAssembly.instantiate(wasmBuf, go.importObject);
    go.run(instance);

    await new Promise(r => setTimeout(r, 500));
    if (typeof globalThis.getAdv !== 'function') throw new Error('getAdv not found after WASM boot');
    wasmReady = true;
  })();
  return bootPromise;
}

// ── Stream URL resolver ───────────────────────────────────────────────────────
async function getStream(id, season, episode) {
  await bootWasm();
  const token = globalThis.getAdv(String(id));
  if (!token) throw new Error('getAdv returned null');

  const apiUrl = season
    ? `https://vidlink.pro/api/b/tv/${token}/${season}/${episode || 1}?multiLang=0`
    : `https://vidlink.pro/api/b/movie/${token}?multiLang=0`;

  const res = await fetch(apiUrl, {
    headers: {
      Referer: REFERER,
      Origin: ORIGIN,
      'User-Agent': UA,
      'x-playback-environment': 'webkit'
    }
  });
  if (!res.ok) throw new Error(`vidlink API returned ${res.status}`);
  const data = await res.json();
  const stream = data?.stream;

  if (!stream) throw new Error('No stream in response');

  // The browser playback path returns DASH with a short-lived CloudFront
  // cookie. Older VidLink responses may still expose HLS here.
  if (typeof stream.playlist === 'string' && stream.playlist) {
    const isDash = stream.type === 'dash' || /\.mpd(?:\?|$)/i.test(stream.playlist);
    const cookie = stream.playlistHeaders?.Cookie || stream.playlistHeaders?.cookie;
    const resolutions = stream.playbackMetadata?.resolutions || [];
    const quality = resolutions
      .map(value => Number.parseInt(value, 10) || 0)
      .sort((a, b) => b - a)[0] || null;

    return {
      url: stream.playlist,
      type: isDash ? 'dash' : 'hls',
      quality: quality ? String(quality) : null,
      codec: stream.playbackMetadata?.codecName || null,
      proxyToken: cookie ? Buffer.from(cookie, 'utf8').toString('base64url') : null
    };
  }

  // Newer responses expose one or more direct video files by quality.
  if (stream.qualities && typeof stream.qualities === 'object') {
    const sources = Object.entries(stream.qualities)
      .filter(([, source]) => source && typeof source.url === 'string' && source.url)
      .sort(([qualityA], [qualityB]) => {
        const a = Number.parseInt(qualityA, 10) || 0;
        const b = Number.parseInt(qualityB, 10) || 0;
        return b - a;
      });

    if (sources.length) {
      const [quality, source] = sources[0];
      return {
        url: source.url,
        type: source.type === 'hls' || /\.m3u8?(?:\?|$)/i.test(source.url) ? 'hls' : 'video',
        quality,
        codec: source.codecName || null
      };
    }
  }

  throw new Error('No playable source in response');
}

// ── Upstream fetcher with redirect and byte-range support ─────────────────────
function fetchUpstream(url, requestHeaders = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return reject(new Error('unsupported upstream protocol'));
    }

    const client = parsedUrl.protocol === 'https:' ? https : http;
    client.get(parsedUrl, {
      headers: {
        Referer: REFERER,
        Origin: ORIGIN,
        'User-Agent': UA,
        Accept: '*/*',
        ...requestHeaders
      }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location;
        res.resume();
        const nextUrl = loc.startsWith('http') ? loc : new URL(loc, parsedUrl).href;
        return resolve(fetchUpstream(nextUrl, requestHeaders, redirects + 1));
      }
      resolve(res);
    }).on('error', reject);
  });
}

function proxyUrl(url, token) {
  return '/api?url=' + encodeURIComponent(url) + (token ? '&token=' + encodeURIComponent(token) : '');
}

function rewriteM3u8(body, url, token) {
  const base = url.split('?')[0];
  const baseDir = base.substring(0, base.lastIndexOf('/') + 1);
  const origin = new URL(url).origin;
  return body.split('\n').map(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    const abs = t.startsWith('http') ? t : t.startsWith('/') ? origin + t : baseDir + t;
    return proxyUrl(abs, token);
  }).join('\n');
}

function rewriteMpd(body, url) {
  if (/<BaseURL\b/i.test(body)) return body;

  const baseDir = new URL('.', url).href;
  const escapedBaseDir = baseDir
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

  return body.replace(/(<MPD\b[^>]*>)/i, `$1\n<BaseURL>${escapedBaseDir}</BaseURL>`);
}

// ── Vercel serverless handler ─────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');

  const { searchParams } = new URL(req.url, 'http://localhost');
  const q = Object.fromEntries(searchParams);

  // Proxy mode: /api?url=...
  if (q.url) {
    // URLSearchParams already decodes the query value once.
    const url = q.url;
    try {
      const requestHeaders = {};
      if (req.headers?.range) requestHeaders.Range = req.headers.range;
      if (q.token) {
        const cookie = Buffer.from(q.token, 'base64url').toString('utf8');
        if (cookie.length > 4096 || /[\r\n]/.test(cookie) || !cookie.includes('CloudFront-')) {
          throw new Error('invalid playback token');
        }
        requestHeaders.Cookie = cookie;
      }

      const upstream = await fetchUpstream(url, requestHeaders);
      const ct = (upstream.headers['content-type'] || '').toLowerCase();
      const isM3u8 = ct.includes('mpegurl') || ct.includes('m3u8') || /\.m3u8?(\?|$)/i.test(url.split('?')[0]);
      const isMpd = ct.includes('dash+xml') || /\.mpd(?:\?|$)/i.test(url.split('?')[0]);

      if (isM3u8 && upstream.statusCode >= 200 && upstream.statusCode < 300) {
        const chunks = [];
        for await (const chunk of upstream) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString('utf8');
        res.statusCode = upstream.statusCode;
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        return res.end(rewriteM3u8(body, url, q.token));
      } else if (isMpd && upstream.statusCode >= 200 && upstream.statusCode < 300) {
        const chunks = [];
        for await (const chunk of upstream) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString('utf8');
        res.statusCode = upstream.statusCode;
        res.setHeader('Content-Type', 'application/dash+xml');
        return res.end(rewriteMpd(body, url));
      } else {
        res.setHeader('Content-Type', ct || 'application/octet-stream');
        for (const header of ['content-length', 'content-range', 'accept-ranges', 'cache-control', 'etag', 'last-modified']) {
          if (upstream.headers[header]) res.setHeader(header, upstream.headers[header]);
        }
        res.statusCode = upstream.statusCode;
        upstream.pipe(res);
      }
    } catch (err) {
      res.statusCode = 502;
      res.end(err.message);
    }
    return;
  }

  // Stream lookup: /api?id=550  or  /api?id=456&s=1&e=2
  if (!q.id) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'missing id' }));
  }

  res.setHeader('Content-Type', 'application/json');
  try {
    const stream = await getStream(q.id, q.s, q.e);
    res.end(JSON.stringify(stream));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: err.message }));
  }
};
