'use strict';
// Animaciones interactivas (<adobe-animate-view>: canvas dibujado por JS + textos animados + play/deslizador):
// se pulsa play, se graba (webm + línea de tiempo) y el HTML guardado funciona con file:// sin internet.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const puppeteer = require('puppeteer');
const { createFixture } = require('./fixture-server');
const { saveChapterHtml } = require('../lib/save-chapter-html');
const { DEFAULT_ASSET_OPTIONS } = require('../lib/download-assets');
const { verifyChapterFile, verifyChapterHtml, chapterUpToDate, countPendingAnimations } = require('../lib/verify-chapter');
const { analyzeHtml, validateCourse } = require('../scripts/validate-download');
const { sanitizeUrl } = require('../lib/capture-animations');

const CHROME = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
const FAST = { ...DEFAULT_ASSET_OPTIONS, retries: 1, backoffMs: 20, timeoutMs: 8000 };

let fx, browser, tmp;
test.before(async () => {
  fx = await createFixture();
  browser = await puppeteer.launch({ headless: true, executablePath: CHROME, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccna-anim-'));
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
  const file = path.join(siteDir, 'chapters', '2.3.html');
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  await page.goto(`${fx.base}/launch?_chapter=2.3&${query}`, { waitUntil: 'networkidle2' });
  const res = await saveChapterHtml(page, file, siteDir, new Map(), '2.3', FAST, undefined, { animationMaxMs: 30000, ...opts });
  await page.close();
  return { siteDir, file, res, html: fs.readFileSync(file, 'utf8') };
}

/** Abre el HTML guardado con file:// (sin servidor) y comprueba panel, controles y peticiones externas. */
async function openOffline(file) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  const external = [];
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    if (!/^(file|data|blob|about):/i.test(r.url())) external.push(r.url());
    r.continue();
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });
  const info = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const find = (root, sel) => {
      const x = root.querySelector(sel);
      if (x) return x;
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) {
          const y = find(el.shadowRoot, sel);
          if (y) return y;
        }
      }
      return null;
    };
    for (let i = 0; i < 40 && !find(document, 'video[data-ccna-anim-video]'); i++) await sleep(100);
    const v = find(document, 'video[data-ccna-anim-video]');
    if (!v) return { video: false };
    for (let i = 0; i < 60 && v.readyState < 2 && !v.error; i++) await sleep(100);
    const box = v.closest('[data-ccna-anim-src]') || v.parentElement;
    const bar = Array.from(box.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === 'Reproducir / pausar');
    const range = bar && bar.parentElement.querySelector('input[type=range]');
    const op = (id) => {
      const el = find(document, '#' + id);
      return el ? getComputedStyle(el).opacity : null;
    };
    const sample = async (sec) => {
      v.currentTime = sec;
      await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
      await sleep(150);
    };
    const out = { video: true, readyState: v.readyState, error: v.error ? v.error.code : null, w: v.videoWidth, h: v.videoHeight };
    out.duration = v.duration;
    out.canvasHidden = find(document, 'canvas') ? getComputedStyle(find(document, 'canvas')).display === 'none' : null;
    out.origControlsHidden = Array.from(box.querySelectorAll('[data-ccna-anim-ctl]')).every((e) => getComputedStyle(e).display === 'none');
    out.hasBar = !!bar && !!range;
    out.opStart = op('t-dr');
    await sample(1.2);
    const rc = v.getBoundingClientRect();
    out.rect = { x: rc.x + scrollX, y: rc.y + scrollY, width: rc.width, height: rc.height };
    out.opEarly = op('t-bdr');
    window.__a = { v, bar, range, find, sleep, sample, op };
    return out;
  });
  if (info.video) {
    // captura de pantalla (el canvas con vídeo de file:// queda «tainted»): ¿hay algo dibujado en el panel?
    const shot = await page.screenshot({ clip: info.rect, encoding: 'base64' });
    info.coloredMid = await page.evaluate(async (b64) => {
      const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
      const c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      const g = c.getContext('2d');
      g.drawImage(bmp, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 150 && d[i + 1] < 100 && d[i + 2] < 100) n++; // el rectángulo rojo de la animación
      return n;
    }, shot);
  }
  const info2 = info.video && await page.evaluate(async () => {
    const { v, bar, range, find, sleep, sample, op } = window.__a;
    const out = {};
    await sample(2.1);
    out.opEnd = op('t-bdr');
    out.textEnd = find(document, '#t-bdr').textContent;
    await sample(2.8);
    out.textLate = find(document, '#t-bdr').textContent;
    await sample(0);
    out.opBack = op('t-bdr');
    // el deslizador avanza al pulsar play
    const r0 = Number(range.value);
    bar.click();
    await sleep(900);
    out.rangeAdvanced = Number(range.value) > r0;
    out.currentTime = v.currentTime;
    out.playing = !v.paused;
    bar.click();
    out.paused = v.paused;
    // arrastrar el deslizador mueve el vídeo
    range.value = '800';
    range.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(200);
    out.seekedTo = v.currentTime / v.duration;
    return out;
  });
  await page.close();
  return { info: { ...info, ...(info2 || {}) }, external, errors };
}

test('la animación se activa, se graba y el HTML funciona con file://: panel con contenido, deslizador que avanza, sin peticiones externas', async () => {
  const { siteDir, file, res, html } = await save('ok', 'clean=1&anim=ok');
  console.log('  avisos:', res.warnings, 'animaciones:', JSON.stringify({ ...res.animations, network: res.animations.network.length }));
  assert.ok(res.ok, res.problems.join('; '));
  assert.equal(res.animations.total, 1);
  assert.equal(res.animations.captured, 1);
  assert.equal(res.animations.pending, 0);
  assert.ok(res.animations.bytes > 1024);
  assert.ok(!res.warnings.some((w) => /animaci/.test(w)), res.warnings.join('|'));
  // las peticiones de la animación (json + png) se vieron durante la activación
  const urls = res.animations.network.map((n) => n.url);
  assert.ok(urls.some((u) => /\/anim\/data\.json\?token=…$/.test(u)), urls.join('\n'));
  assert.ok(urls.some((u) => /\/anim\/sprite\.png$/.test(u)));
  assert.ok(!JSON.stringify(res.animations).includes('SECRETVALUE123'), 'sin valores de query en los resultados');

  assert.match(html, /data-ccna-anim-src="\.\.\/assets\/video\/anim-[0-9a-f]{12}\.webm"/);
  assert.match(html, /name="ccna-dl-anim"/);
  assert.ok(!/127\.0\.0\.1:\d+/.test(html), 'sin URLs del servidor');
  const webms = walk(path.join(siteDir, 'assets', 'video')).filter((f) => f.endsWith('.webm'));
  assert.equal(webms.length, 1);
  assert.ok(fs.statSync(webms[0]).size > 1024);
  assert.equal(fs.readFileSync(webms[0]).subarray(0, 4).toString('hex'), '1a45dfa3', 'es un webm real (EBML)');
  assert.ok(walk(siteDir).every((f) => !f.endsWith('.part') && !f.endsWith('.fix.webm')), 'sin temporales');

  // el validador del curso: sin aviso de animación, y el .webm referenciado existe
  const okCourse = validateCourse(siteDir, {});
  assert.ok(!okCourse.problems.avisos.concat(okCourse.problems.graves).some((x) => /animaci/.test(JSON.stringify(x))), JSON.stringify(okCourse.problems));
  assert.equal(okCourse.chapters[0].animations.offline, 1);
  assert.equal(okCourse.chapters[0].animations.pending, 0);
  assert.equal(okCourse.refs.missing, 0, JSON.stringify(okCourse.problems));

  const v = await verifyChapterFile(file, siteDir);
  assert.ok(v.ok, JSON.stringify(v));
  assert.equal(v.animationsPending, 0);
  assert.equal(v.animAttempted, true);
  assert.equal(chapterUpToDate(v, true, true), true);

  const { info, external, errors } = await openOffline(file);
  console.log('  offline:', JSON.stringify(info), 'externas:', external, 'errores:', errors);
  assert.ok(info.video, 'hay <video> de la animación');
  assert.equal(info.error, null);
  assert.ok(info.readyState >= 2);
  assert.equal(info.w, 480);
  assert.equal(info.h, 320);
  assert.ok(info.duration > 1.5, 'duración de la grabación: ' + info.duration);
  assert.ok(info.canvasHidden, 'el canvas vacío queda oculto');
  assert.ok(info.origControlsHidden, 'controles originales (sin JS) ocultos');
  assert.ok(info.hasBar, 'controles propios');
  assert.ok(info.coloredMid > 500, 'el panel no está vacío (píxeles dibujados en mitad de la animación): ' + info.coloredMid);
  assert.equal(info.opStart, '0', 'al inicio el texto aún no se ve');
  assert.equal(info.opEnd, '1', 'la línea de tiempo muestra el texto al avanzar');
  assert.equal(info.opEarly, '0');
  assert.equal(info.textEnd, 'BDR');
  assert.equal(info.textLate, 'BDR listo', 'el cambio de texto del final también se reproduce');
  assert.equal(info.opBack, '0', 'al volver al inicio se oculta otra vez');
  assert.ok(info.rangeAdvanced, 'el deslizador avanza al pulsar play');
  assert.ok(info.currentTime > 0.3 && info.playing);
  assert.equal(info.paused, true);
  assert.ok(info.seekedTo > 0.6 && info.seekedTo < 0.95, 'arrastrar el deslizador mueve el vídeo: ' + info.seekedTo);
  assert.deepEqual(external, [], 'sin peticiones externas');
  assert.deepEqual(errors, []);
});

test('componente cuyo play no arranca: se avisa "animación sin recursos locales" y queda pendiente (sin bucle al reanudar)', async () => {
  const { file, siteDir, res, html } = await save('dead', 'clean=1&anim=dead');
  assert.ok(res.ok);
  assert.equal(res.animations.total, 1);
  assert.equal(res.animations.pending, 1);
  assert.equal(res.animations.captured, 0);
  assert.ok(res.warnings.some((w) => /animación\(es\) sin recursos locales/.test(w)), res.warnings.join('|'));
  assert.ok(!/data-ccna-anim-src/.test(html.replace(/<script\b[\s\S]*?<\/script>/g, '')));
  const v = await verifyChapterFile(file, siteDir);
  assert.equal(v.animationsPending, 1);
  assert.equal(v.animAttempted, true);
  assert.equal(chapterUpToDate(v, true, true), true, 'ya se intentó: no se repite en bucle');
  const c = validateCourse(siteDir, {});
  assert.equal(c.chapters[0].animations.pending, 1);
  assert.ok(JSON.stringify(c.problems).includes('animación(es) sin recursos locales'), JSON.stringify(c.problems));
}, { timeout: 60000 });

test('--no-animations: no pulsa play; el capítulo queda pendiente y una ejecución con animaciones lo repite', async () => {
  const { file, siteDir, res, html } = await save('noanim', 'clean=1&anim=ok', { animations: false });
  assert.ok(res.ok);
  assert.equal(res.animations, undefined);
  assert.ok(!/name="ccna-dl-anim"/.test(html));
  const v = await verifyChapterFile(file, siteDir);
  assert.equal(v.animationsPending, 1);
  assert.equal(v.animAttempted, false);
  assert.equal(chapterUpToDate(v, true, false), true, 'sin animaciones: está al día');
  assert.equal(chapterUpToDate(v, true, true), false, 'con animaciones: se repite');
});

test('--dump-network: debug-red-<capítulo>.json con componentes y peticiones, sin tokens ni cookies', async () => {
  const { siteDir } = await save('dump', 'clean=1&anim=ok', { dumpNetwork: true });
  const f = path.join(siteDir, 'debug-red-2.3.json');
  assert.ok(fs.existsSync(f), 'existe el volcado');
  const raw = fs.readFileSync(f, 'utf8');
  const j = JSON.parse(raw);
  assert.equal(j.capitulo, '2.3');
  assert.equal(j.animaciones.encontradas, 1);
  assert.equal(j.animaciones.grabadas, 1);
  assert.equal(j.animaciones.componentes[0].recorded, true);
  assert.ok(j.peticiones.some((p) => /\/anim\/data\.json\?token=…$/.test(p.url)));
  assert.ok(!raw.includes('SECRETVALUE123'), 'el valor del token no se guarda');
  const { nota, ...resto } = j;
  assert.ok(!/cookie|authorization|set-cookie/i.test(JSON.stringify(resto)), 'sin cookies ni cabeceras');
  assert.ok(walk(siteDir).every((p) => !p.endsWith('.json.part')));
});

test('sanitizeUrl: sin usuario, sin valores de query, sin fragmento y con tramos de token ocultos', () => {
  assert.equal(sanitizeUrl('https://u:p@h.com/a/b.json?token=abc&x=1#frag'), 'https://h.com/a/b.json?token=…&x=…');
  assert.equal(sanitizeUrl('https://h.com/signed/' + 'A'.repeat(40) + '/f.mp4'), 'https://h.com/signed/<token>/f.mp4');
  assert.equal(sanitizeUrl('data:image/png;base64,AAAA'), 'data:…');
  assert.equal(sanitizeUrl('https://h.com/x.png'), 'https://h.com/x.png');
});

test('countPendingAnimations: componentes sin grabación', () => {
  assert.equal(countPendingAnimations('<adobe-animate-view><template shadowrootmode="open"><div class="c"><canvas></canvas><aa-scrubber></aa-scrubber></div></template></adobe-animate-view>'), 1);
  assert.equal(countPendingAnimations('<adobe-animate-view><template><div data-ccna-anim-src="../assets/video/a.webm"></div></template></adobe-animate-view>'), 0);
  assert.equal(countPendingAnimations('<script>var s="<adobe-animate-view>";</script><p>hola</p>'), 0);
  assert.equal(countPendingAnimations('<p>nada</p>'), 0);
  const w = verifyChapterHtml('<!DOCTYPE html><html><body>' + '<p>texto de relleno suficiente para pasar la verificación</p>'.repeat(60) + '<adobe-animate-view></adobe-animate-view></body></html>');
  assert.ok(w.warnings.some((x) => /animación\(es\) sin recursos locales/.test(x)), w.warnings.join('|'));
});

test('validate-download: analyzeHtml cuenta componentes y grabaciones locales', () => {
  const a = analyzeHtml('<html><body><adobe-animate-view><template shadowrootmode="open"><div class="adobe-animate-container"><canvas></canvas><aa-scrubber></aa-scrubber></div></template></adobe-animate-view></body></html>');
  assert.deepEqual([a.anim.views, a.anim.scrubbers, a.anim.offline, a.anim.attempted], [1, 1, 0, false]);
  const b = analyzeHtml('<html><head><meta name="ccna-dl-anim" content="1"></head><body><adobe-animate-view><template><div data-ccna-anim-src="../assets/video/a.webm"><aa-scrubber></aa-scrubber></div></template></adobe-animate-view></body></html>');
  assert.deepEqual([b.anim.views, b.anim.offline, b.anim.attempted], [1, 1, true]);
  assert.ok(b.refs.some((r) => r.kind === 'data-ccna-anim-src' && r.url === '../assets/video/a.webm'));
});
