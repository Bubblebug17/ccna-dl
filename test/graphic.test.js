'use strict';
// Gráficas dinámicas dentro de pestañas (componentes con shadow DOM anidado y hojas adoptadas, como
// <dynamic-graphic-view> de Netacad): al abrir el HTML guardado con file:// los textos deben quedar DENTRO
// de sus cajas con cualquier tamaño de ventana, en cada pestaña.
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
const { verifyChapterFile, verifyChapterHtml, chapterUpToDate, STYLES_META_RE } = require('../lib/verify-chapter');
const { analyzeHtml } = require('../scripts/validate-download');

const CHROME = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
const FAST = { ...DEFAULT_ASSET_OPTIONS, retries: 1, backoffMs: 20, timeoutMs: 8000 };

let fx, browser, tmp, saved;
test.before(async () => {
  fx = await createFixture();
  browser = await puppeteer.launch({ headless: true, executablePath: CHROME, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccna-graphic-'));
  const siteDir = path.join(tmp, 'site');
  fs.mkdirSync(path.join(siteDir, 'chapters'), { recursive: true });
  const file = path.join(siteDir, 'chapters', '2.3.html');
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  await page.goto(`${fx.base}/launch?_chapter=2.3&graphic=1&clean=1`, { waitUntil: 'networkidle2' });
  await saveChapterHtml(page, file, siteDir, new Map(), '2.3', FAST, undefined, {});
  await page.close();
  saved = { siteDir, file, html: fs.readFileSync(file, 'utf8') };
});
test.after(async () => {
  await browser?.close();
  await fx?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

/** Abre file:// con un ancho dado, activa cada pestaña y mide textos vs cajas. */
async function measure(width, opts = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 900 });
  if (opts.breakAdopted) {
    // simula el cargador antiguo: las hojas adoptadas de los componentes anidados no llegan a aplicarse
    await page.evaluateOnNewDocument(() => {
      CSSStyleSheet.prototype.replaceSync = function () {};
    });
  }
  await page.goto(pathToFileURL(saved.file).href, { waitUntil: 'load' });
  const out = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const deep = (root, sel, acc = []) => {
      root.querySelectorAll(sel).forEach((e) => acc.push(e));
      root.querySelectorAll('*').forEach((el) => el.shadowRoot && deep(el.shadowRoot, sel, acc));
      return acc;
    };
    await sleep(900);
    const tabs = deep(document, '[role=tab].gtab');
    const res = [];
    for (let i = 0; i < tabs.length; i++) {
      tabs[i].click();
      await sleep(900); // relleno con retraso (200 ms) + animación CSS (400 ms)
      const graphics = deep(document, 'x-graphic').filter((g) => g.getClientRects().length > 0);
      const items = [];
      for (const g of graphics) {
        for (const it of g.shadowRoot.querySelectorAll('.item')) {
          const box = g.shadowRoot.getElementById(it.getAttribute('data-box'));
          const r = it.getBoundingClientRect();
          const b = box.getBoundingClientRect();
          items.push({
            text: it.textContent,
            opacity: getComputedStyle(it).opacity,
            w: r.width,
            inside: r.left >= b.left - 1 && r.right <= b.right + 1 && r.top >= b.top - 1 && r.bottom <= b.bottom + 1,
            r: [r.left, r.top, r.right, r.bottom].map(Math.round),
            b: [b.left, b.top, b.right, b.bottom].map(Math.round),
          });
        }
      }
      res.push({ label: tabs[i].textContent, graphics: graphics.length, items });
    }
    const pos = deep(document, 'x-graphic').map((g) => getComputedStyle(g.shadowRoot.querySelector('.content > .dyn') || g).position);
    return { tabs: tabs.length, res, pos };
  });
  await page.close();
  return out;
}

test('el HTML guardado lleva la marca del cargador de estilos y no avisa de estilos antiguos', async () => {
  assert.match(saved.html, STYLES_META_RE);
  assert.ok(/id="__ccna_adopted"/.test(saved.html) && /data-adopted="/.test(saved.html), 'hay hojas adoptadas');
  const v = await verifyChapterFile(saved.file, saved.siteDir);
  assert.ok(v.ok, v.problems.join('; '));
  assert.strictEqual(v.stylesOutdated, false);
  assert.ok(!v.warnings.some((w) => /cargador de estilos antiguo/.test(w)), v.warnings.join('; '));
});

for (const width of [1400, 1000, 640]) {
  test(`file:// ${width}px: en cada pestaña el texto final está dentro de su caja`, async () => {
    const m = await measure(width);
    assert.strictEqual(m.tabs, 2, 'las dos pestañas con su panel');
    for (const t of m.res) {
      assert.strictEqual(t.graphics, 1, `pestaña «${t.label}»: una gráfica visible`);
      assert.ok(t.items.length >= 2, 'hay cajas con texto');
      for (const it of t.items) {
        assert.ok(it.text.trim().length > 0, `pestaña «${t.label}»: caja vacía`);
        assert.strictEqual(it.opacity, '1', `pestaña «${t.label}»: «${it.text}» sin su estado final (opacity ${it.opacity})`);
        assert.ok(it.w > 0, 'el texto ocupa espacio');
        assert.ok(it.inside, `pestaña «${t.label}»: «${it.text}» fuera de su caja ${JSON.stringify({ r: it.r, b: it.b })}`);
      }
    }
  });
}

test('sensibilidad: sin hojas adoptadas en los componentes anidados la comprobación detecta textos fuera de sus cajas', async () => {
  const m = await measure(1000, { breakAdopted: true });
  const bad = m.res.flatMap((t) => t.items).filter((it) => !it.inside || it.w === 0);
  assert.ok(bad.length > 0, 'el test debe fallar cuando el estilo no se aplica');
});

test('un capítulo guardado con el cargador antiguo se detecta y se vuelve a descargar al reanudar', async () => {
  const old = saved.html.replace(/<meta name="ccna-dl-styles"[^>]*>/i, '');
  const v = verifyChapterHtml(old);
  assert.strictEqual(v.stylesOutdated, true);
  assert.ok(v.warnings.some((w) => /cargador de estilos antiguo/.test(w)));
  assert.strictEqual(chapterUpToDate({ ok: true, format: 3, videosPending: 0, stylesOutdated: true }, true, true), false);
  assert.strictEqual(chapterUpToDate({ ok: true, format: 3, videosPending: 0, stylesOutdated: false }, true, true), true);
  // el validador del curso lo detecta también
  const a = analyzeHtml(old);
  assert.strictEqual(a.stylesOutdated, true);
  assert.strictEqual(analyzeHtml(saved.html).stylesOutdated, false);
  assert.strictEqual(analyzeHtml('<html><body><div class="dynamic-text-item text1">  </div></body></html>').emptyBoxes, 1);
});
