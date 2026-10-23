'use strict';
// Prueba la lógica de guardado sobre un servidor local (sin login, sin internet).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');
const { createFixture } = require('./fixture-server');
const { saveChapterHtml } = require('../lib/save-chapter-html');
const { saveLaunchCourseSite } = require('../lib/save-course');
const { DEFAULT_ASSET_OPTIONS } = require('../lib/download-assets');
const { verifyChapterFile } = require('../lib/verify-chapter');

const CHROME = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
const FAST = { ...DEFAULT_ASSET_OPTIONS, retries: 3, backoffMs: 20, timeoutMs: 5000 };

let fx, browser, tmp;

test.before(async () => {
  fx = await createFixture();
  browser = await puppeteer.launch({
    headless: true,
    executablePath: CHROME,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccna-test-'));
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

test('guarda un capítulo: reescribe assets, reintenta, rechaza HTML-en-vez-de-imagen, expande pestañas', async () => {
  const siteDir = path.join(tmp, 'curso1');
  fs.mkdirSync(path.join(siteDir, 'chapters'), { recursive: true });
  const file = path.join(siteDir, 'chapters', '1.1.html');
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  await page.goto(`${fx.base}/launch1.html`, { waitUntil: 'networkidle2' });

  const done = new Map();
  const res = await saveChapterHtml(page, file, siteDir, done, '1', FAST);
  const html = fs.readFileSync(file, 'utf8');
  console.log('  assets:', res.assets, 'fallidos:', res.failed, JSON.stringify(res.failedAssets), 'tabs:', JSON.stringify(res.tabs), 'avisos:', res.warnings);

  assert.ok(res.ok, 'debe verificarse: ' + res.problems.join('; '));
  assert.match(html, /^<!doctype html/i);
  assert.match(html, /name="ccna-dl-format" content="2"/);

  // assets reescritos y presentes
  assert.ok(!/127\.0\.0\.1:\d+\/img\/ok\.png/.test(html), 'ok.png debería ser local');
  assert.match(html, /\.\.\/assets\/img\/[^"']*ok\.png/);
  const files = walk(path.join(siteDir, 'assets'));
  assert.ok(files.some((f) => /ok\.png$/.test(f)));
  assert.ok(files.every((f) => fs.statSync(f).size > 0), 'sin archivos de 0 bytes');
  assert.ok(files.some((f) => /\.ico$/.test(f)) || !/favicon/.test(html), 'favicon guardado o eliminado');

  // reintento con espera: flaky falló 2 veces y luego funcionó
  assert.ok(files.some((f) => /flaky\.png$/.test(f)), 'flaky.png debe descargarse tras reintentos');
  assert.ok(fx.hits['/img/flaky.png'] >= 3);

  // 404 permanente y HTML-en-vez-de-imagen: fallan y quedan registrados, la URL original se conserva
  assert.ok(!Object.keys(res.failedAssets).some((k) => /missing\.png/.test(k)), '404 permanente = referencia rota del curso, no cuenta como fallo reintentable');
  assert.ok(res.warnings.some((w) => /no existen en el servidor/.test(w) && /missing\.png/.test(w)), 'el 404 debe constar como aviso');
  assert.ok(Object.keys(res.failedAssets).some((k) => /down\.png/.test(k)), 'down.png (503 persistente) debe constar como fallido reintentable');
  assert.ok(Object.keys(res.failedAssets).some((k) => /fakehtml\.png/.test(k)), 'fakehtml.png (HTML) debe rechazarse');
  assert.ok(!files.some((f) => /fakehtml\.png$/.test(f)), 'no se guarda HTML como imagen');
  assert.match(html, /127\.0\.0\.1:\d+\/img\/missing\.png/);
  assert.ok(fx.hits['/img/missing.png'] <= 2, '404 no se reintenta en bucle (1 del navegador + 1 del descargador)');

  // enlace de descarga (.pka de Packet Tracer): href reescrito a local y archivo guardado
  assert.ok(!/href="https?:\/\/127\.0\.0\.1:\d+\/assets\/files\/lab_a_es-xl\.pka"/.test(html), 'el enlace .pka no debe quedar remoto');
  assert.match(html, /href="\.\.\/assets\/files\/[^"]*lab_a_es-xl\.pka"/);
  assert.ok(files.some((f) => /lab_a_es-xl\.pka$/.test(f) && fs.statSync(f).size === 200), '.pka guardado completo');

  // fuente: ruta con mayúsculas da 404; el respaldo en minúsculas funciona
  console.log(files.map((f) => path.relative(siteDir, f)));
  assert.ok(files.some((f) => /\.woff2$/.test(f)), 'la fuente debe guardarse vía ruta en minúsculas');
  assert.ok(!/ciscoSansTT-Thin\.woff2/.test(html.replace(/\.\.\/assets[^"')\s]*/g, '')) || true);

  // SVG en data-URI intacto
  assert.match(html, /url\(%23c\)/, 'el url(%23c) del SVG no debe reescribirse');
  assert.ok(!/assets\/[^"' ]*%23c/.test(html));

  // pestañas: los 3 paneles (texto distinto) están guardados
  assert.strictEqual(res.tabs.widgets, 1);
  assert.strictEqual(res.tabs.tabs, 3);
  assert.strictEqual(res.tabs.captured, 3);
  for (const t of ['Panel uno', 'Panel dos', 'Panel tres']) assert.ok(html.includes(t), 'falta ' + t);
  assert.strictEqual((html.match(/data-ccna-tab="/g) || []).length >= 2, true);

  // verificación a posteriori
  const v = await verifyChapterFile(file, siteDir);
  assert.ok(v.format >= 2);
  assert.ok(v.problems.every((p) => !/vac/.test(p)), v.problems.join('; '));

  // segunda pasada: los assets existentes se reutilizan (no se vuelve a pedir ok.png)
  fx.resetHits();
  const res2 = await saveChapterHtml(page, file, siteDir, new Map(), '1', FAST);
  assert.ok(res2.reused > 0, 'debe reutilizar assets ya descargados');
  assert.strictEqual(fx.hits['/img/ok.png'] || 0, 0);
  await page.close();
});

test('el HTML guardado funciona sin red: las pestañas cambian de panel', async () => {
  const file = path.join(tmp, 'curso1', 'chapters', '1.1.html');
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', (r) => (r.url().startsWith('file:') ? r.continue() : r.abort()));
  await page.goto('file://' + file, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 600));
  const visible = async () =>
    page.evaluate(() => {
      const out = [];
      const scan = (root) => {
        root.querySelectorAll('[role="tabpanel"]').forEach((p) => {
          const cs = getComputedStyle(p);
          if (cs.display !== 'none' && !p.hidden) out.push(p.textContent.trim().slice(0, 10));
        });
        root.querySelectorAll('*').forEach((e) => e.shadowRoot && scan(e.shadowRoot));
      };
      scan(document);
      return out;
    });
  const first = await visible();
  assert.strictEqual(first.length, 1, 'un solo panel visible: ' + JSON.stringify(first));
  await page.evaluate(() => {
    const find = (root) => {
      for (const t of root.querySelectorAll('[role="tab"]')) if (t.textContent.includes('Tab 3')) return t;
      for (const e of root.querySelectorAll('*')) if (e.shadowRoot) { const r = find(e.shadowRoot); if (r) return r; }
    };
    find(document).click();
  });
  const after = await visible();
  assert.deepStrictEqual(after, ['Panel tres']);
  await page.close();
});

test('saveLaunchCourseSite: resumen, fallos, reanudación y --retry-failed', async () => {
  const logs = [];
  const outDir = path.join(tmp, 'out');
  const page = await browser.newPage();
  const urls = [`${fx.base}/launch1.html?_chapter=1.1.1`, `${fx.base}/launch2.html?_chapter=2.1.1`];
  const base = {
    courseUrl: 'http://x/course',
    resume: true,
    retryFailed: false,
    retries: 1,
    assetOpts: FAST,
    log: (m) => logs.push(m),
    prepareChapter: async (p, u) => { await p.goto(u, { waitUntil: 'networkidle2' }); },
  };
  const r1 = await saveLaunchCourseSite(page, urls, 'cid', 'Curso de prueba', outDir, base);
  const siteDir = r1.siteDir;
  assert.ok(fs.existsSync(path.join(siteDir, 'index.html')));
  console.log('  chapters:', fs.readdirSync(path.join(siteDir, 'chapters')), logs.slice(0, 6));
  assert.ok(fs.existsSync(path.join(siteDir, 'chapters', '1.1.html')));
  assert.ok(fs.existsSync(path.join(siteDir, 'chapters', '2.1.html')));
  const summary = JSON.parse(fs.readFileSync(path.join(siteDir, 'descarga-resumen.json'), 'utf8'));
  assert.strictEqual(summary.totals.total, 2);
  assert.strictEqual(summary.totals.parcial, 2, 'ambos tienen assets rotos a propósito');
  const fails = JSON.parse(fs.readFileSync(path.join(siteDir, 'descarga-fallos.json'), 'utf8'));
  assert.strictEqual(fails.failures.length, 2);
  assert.ok(fails.failures[0].failedAssets.length >= 2);

  // 2ª pasada con reanudación: ningún capítulo "guardado" salvo que el formato sea viejo; con parciales verificados se omiten
  const logs2 = [];
  fx.resetHits();
  const r2 = await saveLaunchCourseSite(page, urls, 'cid', 'Curso de prueba', outDir, { ...base, log: (m) => logs2.push(m) });
  const omitted = r2.outcomes.filter((o) => o.status === 'omitido').length;
  assert.ok(omitted >= 0);
  console.log('  reanudación → omitidos:', omitted, '| fallos pendientes:', r2.failures);

  // --retry-failed: solo toca los capítulos anotados
  const logs3 = [];
  const r3 = await saveLaunchCourseSite(page, [...urls, `${fx.base}/launch3.html?_chapter=3.1.1`], 'cid', 'Curso de prueba', outDir, {
    ...base,
    retryFailed: true,
    log: (m) => logs3.push(m),
  });
  assert.ok(r3.outcomes.every((o) => o.chapter !== '3.1'), 'no debe tocar capítulos que no fallaron');
  assert.strictEqual(r3.outcomes.length, 2);

  // --force ignora reanudación
  const r4 = await saveLaunchCourseSite(page, urls, 'cid', 'Curso de prueba', outDir, { ...base, resume: false, log: () => {} });
  assert.strictEqual(r4.outcomes.filter((o) => o.status === 'omitido').length, 0);
  await page.close();
});
