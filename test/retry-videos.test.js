'use strict';
// Vídeos HLS protegidos (cookie firmada por vídeo + Referer del reproductor), como los de videos.netacad.com:
// se descargan con la sesión del navegador, una firma caducada provoca una re-captura del subcapítulo
// con URL/cookie nuevas, y lo que no se pudo bajar queda en descarga-fallos.json con ids estables
// para --retry-failed. Sin login ni internet: servidor local (test/fixture-server.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');
const { createFixture, makeMedia } = require('./fixture-server');
const { saveLaunchCourseSite } = require('../lib/save-course');
const { DEFAULT_ASSET_OPTIONS } = require('../lib/download-assets');
const { gotoChapter, waitForChapterContent } = require('../lib/wait-for-chapter-content');
const { getWaitPolicy, setWaitPolicy } = require('../lib/wait-policy');
const { ffmpegExitLabel } = require('../lib/ffmpeg-download');
const { pickVariant } = require('../lib/hls-download');
const { videoRefFromUrl } = require('../lib/stream-auth');
const { failedSummary, stripUrl, shortWarnings } = require('../lib/warnings');
const { cleanTitle } = require('../lib/ui/titles');

const CHROME = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
const FAST = { ...DEFAULT_ASSET_OPTIONS, retries: 1, backoffMs: 20, timeoutMs: 8000 };
const SKIP = makeMedia().ok ? false : 'ffmpeg no disponible';

let fx, browser, tmp;
let seq = 0;
test.before(async () => {
  fx = await createFixture();
  browser = await puppeteer.launch({ headless: true, executablePath: CHROME, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccna-rv-'));
  setWaitPolicy({});
  Object.assign(getWaitPolicy(), { minWaitMs: 300, stableMs: 250, maxStableMs: 3000, shellStableMs: 300, networkIdleMs: 200 });
});
test.after(async () => {
  await browser?.close();
  await fx?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const walk = (d) =>
  fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : [];

async function run(vid, exp, outDir, over = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  const logs = [];
  try {
    const url = `${fx.base}/launch?view=1&_chapter=3.5.1&clean=1&video=hlsauth&vid=${vid}&exp=${exp}`;
    const r = await saveLaunchCourseSite(page, [url], 'cid', 'Curso de prueba', outDir, {
      courseUrl: 'http://x/course',
      resume: true,
      retryFailed: false,
      retries: 1,
      assetOpts: FAST,
      prepareChapter: async (p, u) => {
        await gotoChapter(p, u);
        await waitForChapterContent(p, u);
      },
      log: (m, level, kind) => logs.push({ m, level: level ?? 2, kind }),
      ...over,
    });
    return { r, logs };
  } finally {
    await page.close().catch(() => {});
  }
}
const reqs = (vid) => fx.hlsLog.filter((h) => h.path.includes(`/videos/${vid}/`));
const mp4s = (siteDir) => walk(path.join(siteDir, 'assets', 'video')).filter((f) => f.endsWith('.mp4'));

test('HLS con cookie firmada + Referer: Node lo baja con las cookies de la sesión y la mejor variante; ffmpeg solo remuxa', { skip: SKIP }, async () => {
  const { r } = await run('vidok', 'none', path.join(tmp, `ok-${++seq}`));
  assert.deepStrictEqual(r.outcomes.map((o) => o.status), ['guardado'], JSON.stringify(r.outcomes));
  const vids = mp4s(r.siteDir);
  assert.strictEqual(vids.length, 1);
  assert.strictEqual(fs.readFileSync(vids[0]).subarray(4, 8).toString(), 'ftyp');
  const fromNode = reqs('vidok').filter((h) => h.node);
  assert.ok(fromNode.length >= 3, 'manifiesto, variante y segmentos desde Node: ' + JSON.stringify(reqs('vidok')));
  assert.ok(fromNode.every((h) => h.ok && h.tok && /\/authoring-resources\//.test(h.referer)), 'con la cookie y el Referer del reproductor');
  assert.ok(!fromNode.some((h) => h.path.endsWith('low.m3u8')), 'elige la variante de más BANDWIDTH');
  const html = fs.readFileSync(path.join(r.siteDir, 'chapters', '3.5.html'), 'utf8');
  assert.match(html, /<video\b[^>]*\ssrc="\.\.\/assets\/video\/[^"]+\.mp4"/);
});

test('firma caducada (403): se reabre el subcapítulo, se re-captura la URL/cookie y se descarga en la misma ejecución', { skip: SKIP }, async () => {
  const { r, logs } = await run('videxp', 'first', path.join(tmp, `exp-${++seq}`));
  assert.deepStrictEqual(r.outcomes.map((o) => o.status), ['guardado'], JSON.stringify(r.outcomes));
  assert.strictEqual(fx.grants.videxp, 2, 'el reproductor se reactivó: segunda firma');
  const rs = reqs('videxp');
  const first = rs[0].tok;
  assert.ok(rs.some((h) => h.node && h.tok === first && !h.ok), 'la 1ª firma dio 403 a la descarga');
  assert.ok(rs.some((h) => h.node && h.tok && h.tok !== first && h.ok), 'la descarga con la firma nueva funcionó');
  assert.strictEqual(mp4s(r.siteDir).length, 1);
  assert.ok(logs.some((l) => /se reabre el subcapítulo/.test(l.m) && l.level === 3));
  assert.ok(!logs.some((l) => l.kind === 'error'), 'sin [ERROR]: ' + JSON.stringify(logs.filter((l) => l.kind === 'error')));
});

test('403 persistente: una línea WARN corta, ids estables en descarga-fallos.json y --retry-failed lo recupera', { skip: SKIP }, async () => {
  const dir = path.join(tmp, `all-${++seq}`);
  const { r, logs } = await run('vidall', 'all', dir);
  assert.deepStrictEqual(r.outcomes.map((o) => o.status), ['parcial']);
  const shown = logs.filter((l) => l.level <= 2 || l.kind === 'warn' || l.kind === 'error');
  const line = shown.find((l) => /vídeo sin descargar/.test(l.m));
  assert.ok(line, JSON.stringify(shown));
  assert.strictEqual(line.kind, 'warn');
  assert.match(line.m, /^3\.5\b.*: 1 vídeo sin descargar \(403, la sesión expiró\); se reintentarán con --retry-failed/);
  assert.ok(!shown.some((l) => /https?:|ffmpeg/.test(l.m)), 'sin URLs ni ffmpeg en pantalla: ' + JSON.stringify(shown));
  assert.ok(logs.some((l) => l.level === 3 && /recurso fallido/.test(l.m)), 'el detalle sigue en el registro (-v 3)');

  const ff = JSON.parse(fs.readFileSync(path.join(r.siteDir, 'descarga-fallos.json'), 'utf8'));
  assert.strictEqual(ff.failures.length, 1);
  const f = ff.failures[0];
  assert.deepStrictEqual(
    f.failedVideos.map((v) => [v.videoId, v.version, v.locale, v.index]),
    [['vidall', '1', 'en-US', 1]]
  );
  assert.match(f.failedVideos[0].file, /assets\/video\/.+\.mp4$/);
  assert.ok(!/https?:/.test(JSON.stringify(f.failedAssets)) && !/https?:/.test(f.reason), 'sin URLs firmadas en el estado');
  const html1 = fs.readFileSync(path.join(r.siteDir, 'chapters', '3.5.html'), 'utf8');

  // la sesión "se renueva": --retry-failed vuelve a abrir el subcapítulo y captura una URL nueva
  fx.setHlsExp('vidall', 'none');
  const before = fx.grants.vidall;
  const { r: r2, logs: logs2 } = await run('vidall', 'all', dir, { retryFailed: true });
  assert.deepStrictEqual(r2.outcomes.map((o) => o.status), ['guardado'], JSON.stringify(r2.outcomes));
  assert.ok(fx.grants.vidall > before, 'firma nueva');
  assert.strictEqual(mp4s(r2.siteDir).length, 1);
  const html2 = fs.readFileSync(path.join(r2.siteDir, 'chapters', '3.5.html'), 'utf8');
  assert.ok(!/\.\.\/assets\/video\/[^"]+\.mp4/.test(html1) && /\.\.\/assets\/video\/[^"]+\.mp4/.test(html2), 'el vídeo se sustituye en el HTML solo al bajarlo');
  const info = logs2.find((l) => /^Reintentando 1 subcapítulo/.test(l.m));
  assert.ok(info && info.kind === 'info', JSON.stringify(logs2.slice(0, 5)));
  assert.ok(!fs.existsSync(path.join(r2.siteDir, 'descarga-fallos.json')) || JSON.parse(fs.readFileSync(path.join(r2.siteDir, 'descarga-fallos.json'), 'utf8')).failures.length === 0);
});

test('salida: código de ffmpeg de Windows, títulos limpios, resumen corto', () => {
  assert.strictEqual(ffmpegExitLabel(3436169992), 'HTTP 403'); // AVERROR_HTTP_FORBIDDEN como uint32
  assert.strictEqual(ffmpegExitLabel(-858797304), 'HTTP 403');
  assert.strictEqual(ffmpegExitLabel(1), 'código 1');
  assert.strictEqual(cleanTitle('1.2', 'Módulo 1: Conceptos de OSPFv2 de área única | 1.2. Paquetes de OSPF\u206A'), 'Paquetes de OSPF');
  assert.strictEqual(cleanTitle('1.2', '1.2.\u206A Paquetes\u200B de OSPF'), 'Paquetes de OSPF');
  assert.strictEqual(cleanTitle('9', 'Módulo 9: Conceptos de QoS | 9.1. Calidad de video y de red'), 'Conceptos de QoS');
  assert.deepStrictEqual(
    videoRefFromUrl('https://videos.netacad.com/videos/abc-1/versions/1/locales/en-US/videohls/abc-1.m3u8?x=1', 'assets/video/a.mp4'),
    { file: 'assets/video/a.mp4', videoId: 'abc-1', version: '1', locale: 'en-US' }
  );
  assert.strictEqual(
    failedSummary({ 'assets/video/a.mp4': 'vídeo: acceso denegado (HTTP 403, …) (https://x/y.m3u8)', 'assets/video/b.mp4': 'ffmpeg falló (HTTP 403): Server returned 403 Forbidden' }),
    '2 vídeos sin descargar (403, la sesión expiró); se reintentarán con --retry-failed'
  );
  assert.strictEqual(stripUrl('HTTP 500 (https://a/b.png)'), 'HTTP 500');
  assert.deepStrictEqual(shortWarnings(['3 contenedor(es) de contenido vacío(s) (div.x)']), [], 'los bloques vacíos solo van a -v 3');
  const v = pickVariant('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",DEFAULT=YES,URI="aud/x.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=5,AUDIO="a"\nlo.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=9,AUDIO="a"\nhi/v.m3u8\n', 'https://h/p/m.m3u8');
  assert.deepStrictEqual(v, { video: 'https://h/p/hi/v.m3u8', audio: 'https://h/p/aud/x.m3u8' });
});
