'use strict';
// Vídeos: el reproductor perezoso (póster + play) se activa, el vídeo y los subtítulos se descargan,
// se reescriben a rutas locales y se reproducen abriendo el HTML con file:// (sin servidor ni internet).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const puppeteer = require('puppeteer');
const { createFixture, makeMedia } = require('./fixture-server');
const { saveChapterHtml } = require('../lib/save-chapter-html');
const { DEFAULT_ASSET_OPTIONS } = require('../lib/download-assets');
const { verifyChapterFile, chapterUpToDate, countPendingVideos, CHAPTER_FORMAT } = require('../lib/verify-chapter');
const { pickMediaUrl } = require('../lib/capture-videos');
const { inlineLocalTracks, vttToDataUri } = require('../lib/inline-vtt');
const { buildFfmpegArgs, isStreamManifestUrl } = require('../lib/ffmpeg-download');

const CHROME = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
const FAST = { ...DEFAULT_ASSET_OPTIONS, retries: 1, backoffMs: 20, timeoutMs: 8000 };
const HAS_MEDIA = makeMedia().ok;
const SKIP = HAS_MEDIA ? false : 'ffmpeg no disponible';

let fx, browser, tmp;
test.before(async () => {
  fx = await createFixture();
  browser = await puppeteer.launch({ headless: true, executablePath: CHROME, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccna-video-'));
});
test.after(async () => {
  await browser?.close();
  await fx?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const walk = (d) =>
  fs.existsSync(d)
    ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
    : [];

async function save(name, query, opts = {}) {
  const siteDir = path.join(tmp, name);
  fs.mkdirSync(path.join(siteDir, 'chapters'), { recursive: true });
  const file = path.join(siteDir, 'chapters', '1.html');
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  await page.goto(`${fx.base}/launch?_chapter=1.1.1&${query}`, { waitUntil: 'networkidle2' });
  const res = await saveChapterHtml(page, file, siteDir, new Map(), '1', FAST, undefined, opts);
  await page.close();
  return { siteDir, file, res, html: fs.readFileSync(file, 'utf8') };
}

/** Abre el HTML guardado con file:// y devuelve el estado del <video>. Cuenta peticiones externas. */
async function playOffline(file) {
  const page = await browser.newPage();
  const external = [];
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    const u = r.url();
    if (!/^(file|data|blob|about):/i.test(u)) external.push(u);
    r.continue();
  });
  await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });
  const state = await page.evaluate(async () => {
    const find = (root) => {
      for (const el of root.querySelectorAll('*')) {
        if (el.tagName === 'VIDEO') return el;
        if (el.shadowRoot) {
          const x = find(el.shadowRoot);
          if (x) return x;
        }
      }
      return null;
    };
    const v = find(document);
    if (!v) return { found: false };
    const t0 = Date.now();
    while (v.readyState < 1 && !v.error && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 100));
    let cues = 0;
    for (const t of v.textTracks) {
      t.mode = 'hidden';
    }
    const t1 = Date.now();
    while (Date.now() - t1 < 3000) {
      cues = 0;
      for (const t of v.textTracks) cues += t.cues ? t.cues.length : 0;
      if (cues) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    // reproducción real: avanza el reloj
    let played = false;
    try {
      v.muted = true;
      await v.play();
      const t2 = Date.now();
      while (Date.now() - t2 < 4000 && v.currentTime < 0.3) await new Promise((r) => setTimeout(r, 100));
      played = v.currentTime > 0;
    } catch {
      played = false;
    }
    return {
      found: true,
      readyState: v.readyState,
      duration: v.duration,
      error: v.error ? v.error.code : null,
      tracks: v.textTracks.length,
      cues,
      src: v.getAttribute('src'),
      poster: v.getAttribute('poster'),
      played,
    };
  });
  await page.close();
  return { state, external };
}

test('mp4 con URL firmada sin extensión: se activa, se descarga, se reescribe y se reproduce con file://', { skip: SKIP }, async () => {
  const { siteDir, file, res, html } = await save('mp4', 'clean=1&video=mp4');
  console.log('  avisos:', res.warnings, 'vídeos:', JSON.stringify(res.videos));
  assert.ok(res.ok, res.problems.join('; '));
  assert.equal(res.videos.total, 1);
  assert.equal(res.videos.captured, 1);
  assert.equal(res.videos.pending, 0);
  assert.equal(res.failed, 0, JSON.stringify(res.failedAssets));

  assert.match(html, /<video\b[^>]*data-ccna-media="1"/);
  assert.match(html, /<video\b[^>]*\ssrc="\.\.\/assets\/video\/[^"]+\.mp4"/, 'src local .mp4 aunque la URL no tuviera extensión');
  assert.ok(!/127\.0\.0\.1:\d+\/media/.test(html), 'sin URLs del servidor');
  assert.ok(!/vjs-big-play-button/.test(html), 'ya no queda el botón de play perezoso');
  assert.match(html, /<track\b[^>]*src="data:text\/vtt/, 'subtítulos incrustados');
  assert.match(html, /poster="\.\.\/assets\/img\/[^"]*ok\.png"/);

  const vids = walk(path.join(siteDir, 'assets', 'video')).filter((f) => f.endsWith('.mp4'));
  assert.equal(vids.length, 1);
  assert.equal(fs.readFileSync(vids[0]).subarray(4, 8).toString(), 'ftyp');

  const v = await verifyChapterFile(file, siteDir);
  assert.ok(v.ok, JSON.stringify(v));
  assert.equal(v.videosPending, 0);

  const { state, external } = await playOffline(file);
  console.log('  offline:', JSON.stringify(state), 'externas:', external);
  assert.ok(state.found, 'hay <video>');
  assert.ok(state.readyState >= 1, 'readyState>=1 (metadatos cargados)');
  assert.ok(state.duration > 1.5 && state.duration < 3, 'duración ~2 s: ' + state.duration);
  assert.equal(state.error, null);
  assert.ok(state.tracks >= 1 && state.cues === 2, 'subtítulos con 2 cues: ' + JSON.stringify(state));
  assert.ok(state.played, 'el vídeo avanza al reproducir');
  assert.deepEqual(external, [], 'sin peticiones externas');
});

test('HLS (blob: + manifiesto .m3u8): se baja con ffmpeg a mp4 local y se reproduce con file://', { skip: SKIP }, async () => {
  const { siteDir, file, res, html } = await save('hls', 'clean=1&video=hls');
  console.log('  avisos:', res.warnings, 'vídeos:', JSON.stringify(res.videos), 'fallidos:', JSON.stringify(res.failedAssets));
  assert.ok(res.ok, res.problems.join('; '));
  assert.equal(res.videos.captured, 1);
  assert.equal(res.videos.streams, 1);
  assert.equal(res.failed, 0, JSON.stringify(res.failedAssets));
  assert.match(html, /<video\b[^>]*\ssrc="\.\.\/assets\/video\/[^"]+\.mp4"/);
  const vids = walk(path.join(siteDir, 'assets', 'video')).filter((f) => f.endsWith('.mp4'));
  assert.equal(vids.length, 1);
  assert.equal(fs.readFileSync(vids[0]).subarray(4, 8).toString(), 'ftyp', 'es un mp4 real, no el manifiesto');
  assert.ok(walk(siteDir).every((f) => !f.endsWith('.part')), 'sin .part');

  const { state, external } = await playOffline(file);
  assert.ok(state.found && state.readyState >= 1 && state.duration > 1.5, JSON.stringify(state));
  assert.ok(state.played);
  assert.deepEqual(external, []);
});

test('reproductor que no se monta: se conserva el póster, se avisa y queda pendiente (no se omite al reanudar con vídeos)', async () => {
  const { file, siteDir, res, html } = await save('none', 'clean=1&video=none');
  assert.ok(res.ok);
  assert.equal(res.videos.total, 1);
  assert.equal(res.videos.pending, 1);
  assert.ok(res.warnings.some((w) => /sin reproductor offline/.test(w)), res.warnings.join('|'));
  assert.match(html, /vjs-big-play-button/);
  const v = await verifyChapterFile(file, siteDir);
  assert.equal(v.videosPending, 1);
  assert.match(html, new RegExp(`name="ccna-dl-format" content="${CHAPTER_FORMAT}"`));
});

test('--no-videos: no pulsa play, guarda formato 2 y una ejecución posterior con vídeos repite el capítulo', async () => {
  const { file, siteDir, res, html } = await save('novideos', 'clean=1&video=mp4', { videos: false });
  assert.ok(res.ok);
  assert.equal(res.videos, undefined);
  assert.match(html, /vjs-big-play-button/);
  assert.ok(!/<video\b/.test(html));
  assert.match(html, /name="ccna-dl-format" content="2"/);
  const v = await verifyChapterFile(file, siteDir);
  assert.equal(v.videosPending, 1);
  assert.equal(chapterUpToDate(v, false), true, 'sin vídeos: está al día');
  assert.equal(chapterUpToDate(v, true), false, 'con vídeos: se repite');
});

test('subtemas: las IPs del texto no generan subtemas falsos y el subtema real sí se detecta', async () => {
  const { res, html } = await save('subs', 'clean=1');
  const subs = res.subtopics.map((s) => s.sub);
  console.log('  subtopics:', JSON.stringify(res.subtopics));
  assert.deepEqual(subs, ['1.1.1']);
  assert.ok(!/data-sub="(10\.1\.0|172\.16\.5|2\.2\.2)"/.test(html), 'sin data-sub falsos');
});

test('chapterUpToDate: formato 2 solo se repite si tiene vídeos pendientes', () => {
  const ok = (format, videosPending) => ({ ok: true, format, videosPending });
  assert.equal(chapterUpToDate(ok(3, 0), true), true);
  assert.equal(chapterUpToDate(ok(3, 2), true), true, 'ya se intentó (no hay bucle de reintentos)');
  assert.equal(chapterUpToDate(ok(2, 0), true), true, 'capítulos sin vídeos no se repiten');
  assert.equal(chapterUpToDate(ok(2, 1), true), false);
  assert.equal(chapterUpToDate(ok(1, 0), true), false);
  assert.equal(chapterUpToDate(ok(2, 1), false), true);
  assert.equal(chapterUpToDate(ok(1, 0), false), false);
  assert.equal(chapterUpToDate({ ok: false, format: 3, videosPending: 0 }, true), false);
});

test('countPendingVideos: botones play sin <video> propio', () => {
  assert.equal(countPendingVideos('<button class="vjs-big-play-button"></button><button class="vjs-big-play-button"></button>'), 2);
  assert.equal(countPendingVideos('<video src="a.mp4"></video><button class="vjs-big-play-button"></button>'), 0);
  assert.equal(countPendingVideos('<style>.vjs-big-play-button{x:y}</style><p>hola</p>'), 0);
});

test('pickMediaUrl: mp4 directo > manifiesto declarado > manifiesto visto en la red (blob:) > vídeo visto', () => {
  const none = { src: '', sources: [] };
  assert.deepEqual(pickMediaUrl({ src: 'https://c/x.mp4?sig=1', sources: [] }, []), { url: 'https://c/x.mp4?sig=1', stream: false });
  assert.deepEqual(pickMediaUrl({ src: 'https://c/signed/abc', sources: [] }, []), { url: 'https://c/signed/abc', stream: false });
  assert.deepEqual(pickMediaUrl({ src: '', sources: [{ src: 'https://c/a.m3u8', type: 'application/x-mpegURL' }, { src: 'https://c/a.mp4', type: 'video/mp4' }] }, []), { url: 'https://c/a.mp4', stream: false });
  assert.deepEqual(pickMediaUrl({ src: 'https://c/a.m3u8', sources: [] }, []), { url: 'https://c/a.m3u8', stream: true });
  assert.deepEqual(pickMediaUrl(none, [{ url: 'https://c/seg1.ts', type: '' }, { url: 'https://c/master.m3u8?t=1', type: 'application/vnd.apple.mpegurl' }]), { url: 'https://c/master.m3u8?t=1', stream: true });
  assert.deepEqual(pickMediaUrl(none, [{ url: 'https://c/v', type: 'video/mp4' }]), { url: 'https://c/v', stream: false });
  assert.equal(pickMediaUrl(none, []), null);
  assert.equal(pickMediaUrl({ src: 'blob:https://x/1', sources: [] }, []), null);
});

test('inlineLocalTracks: el .vtt local pasa a data: y el archivo se conserva', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'vtt-'));
  fs.mkdirSync(path.join(dir, 'assets', 'files'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'assets', 'files', 's.vtt'), 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHola ñ\n');
  const html = '<video><track kind="captions" src="../assets/files/s.vtt" data-ccna-ext="vtt"><track src="../assets/files/falta.vtt"></video>';
  const r = await inlineLocalTracks(html, dir);
  assert.equal(r.inlined, 1);
  assert.deepEqual(r.missing, ['../assets/files/falta.vtt']);
  const m = r.html.match(/src="(data:text\/vtt[^"]+)"/);
  assert.ok(m);
  assert.match(Buffer.from(m[1].split(',')[1], 'base64').toString('utf8'), /Hola ñ/);
  assert.ok(!/data-ccna-ext/.test(r.html));
  assert.match(vttToDataUri('WEBVTT'), /^data:text\/vtt;charset=utf-8;base64,/);
});

test('ffmpeg: argumentos con cabeceras en -headers y detección de manifiestos', () => {
  const args = buildFfmpegArgs('https://c/a.m3u8?x=1', '/tmp/o.mp4.part', { 'User-Agent': 'UA', Referer: 'https://r/', Cookie: 'k=v' });
  assert.ok(args.includes('-i') && args[args.indexOf('-i') + 1] === 'https://c/a.m3u8?x=1');
  assert.equal(args[args.indexOf('-user_agent') + 1], 'UA');
  assert.equal(args[args.indexOf('-headers') + 1], 'Referer: https://r/\r\nCookie: k=v\r\n');
  assert.equal(args[args.length - 1], '/tmp/o.mp4.part');
  assert.ok(isStreamManifestUrl('https://c/a.m3u8?x=1') && isStreamManifestUrl('https://c/a.mpd') && !isStreamManifestUrl('https://c/a.mp4'));
});
