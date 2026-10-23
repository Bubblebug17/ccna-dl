'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { backoffMs, withRetry, mapPool, waitUntil, fmtDuration } = require('../lib/util/retry');
const { verifyChapterHtml } = require('../lib/verify-chapter');
const { lowercasePathVariant } = require('../lib/download-assets');

test('backoffMs crece y respeta el máximo', () => {
  const a = backoffMs(0, 100, 1000);
  const b = backoffMs(3, 100, 1000);
  assert.ok(a >= 50 && a <= 1000);
  assert.ok(b <= 1000 * 1.2 + 1);
  assert.ok(backoffMs(10, 100, 1000) <= 1000 * 1.2 + 1); // jitter ±20 %
  assert.ok(backoffMs(3, 100, 100000) >= 800 * 0.8 - 1);
});

test('withRetry reintenta y acaba bien', async () => {
  let n = 0;
  const v = await withRetry(
    async () => {
      if (++n < 3) throw new Error('fallo ' + n);
      return 'ok';
    },
    { retries: 3, baseMs: 5, maxMs: 10 }
  );
  assert.strictEqual(v, 'ok');
  assert.strictEqual(n, 3);
});

test('withRetry se rinde tras agotar reintentos', async () => {
  let n = 0;
  await assert.rejects(
    withRetry(async () => { n++; throw new Error('siempre'); }, { retries: 2, baseMs: 1, maxMs: 2 }),
    /siempre/
  );
  assert.strictEqual(n, 3);
});

test('mapPool respeta la concurrencia máxima y conserva el orden', async () => {
  let active = 0;
  let peak = 0;
  const out = await mapPool(Array.from({ length: 20 }, (_, i) => i), 4, async (i) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return i * 2;
  });
  assert.ok(peak <= 4, 'pico ' + peak);
  assert.deepStrictEqual(out.map((r) => r.ok && r.value), Array.from({ length: 20 }, (_, i) => i * 2));
});

test('waitUntil devuelve pronto si se cumple y false si no', async () => {
  const t0 = Date.now();
  let k = 0;
  assert.strictEqual(await waitUntil(() => ++k > 2, 2000, 10), true);
  assert.ok(Date.now() - t0 < 500);
  const t1 = Date.now();
  assert.strictEqual(await waitUntil(() => false, 150, 20), false);
  assert.ok(Date.now() - t1 >= 140);
  assert.strictEqual(await waitUntil(() => { throw new Error('x'); }, 60, 20), false);
});

test('fmtDuration', () => {
  assert.strictEqual(fmtDuration(4000), '4s');
  assert.strictEqual(fmtDuration(65000), '1m 5s');
});

test('lowercasePathVariant solo cambia la ruta', () => {
  assert.strictEqual(
    lowercasePathVariant('https://x.com/Fonts/ciscoSansTT-Thin.woff2?V=1'),
    'https://x.com/fonts/ciscosanstt-thin.woff2?V=1'
  );
  assert.strictEqual(lowercasePathVariant('https://x.com/a/b.png'), null);
});

const bigText = 'texto real del capítulo '.repeat(120);
const wrap = (body, extra = '') =>
  `<!doctype html><html><head><meta charset="utf-8">${extra}</head><body>${body}</body></html>`;

test('verifyChapterHtml acepta un capítulo correcto', () => {
  const r = verifyChapterHtml(wrap(`<p>${bigText}</p>`));
  assert.strictEqual(r.ok, true, JSON.stringify(r.problems));
});

test('verifyChapterHtml rechaza vacío, spinner y truncado', () => {
  assert.strictEqual(verifyChapterHtml('').ok, false);
  assert.strictEqual(verifyChapterHtml(wrap('<p>Cargando...</p>' + ' '.repeat(2500))).ok, false);
  assert.strictEqual(verifyChapterHtml(wrap(`<p>${bigText}</p>`).replace('</html>', '')).ok, false);
});

test('verifyChapterHtml avisa de pestañas sin panel y lee el formato', () => {
  const r = verifyChapterHtml(
    wrap(`<div role="tab"></div><div role="tab"></div><div role="tabpanel">${bigText}</div>`, '<meta name="ccna-dl-format" content="2">')
  );
  assert.strictEqual(r.format, 2);
  assert.ok(r.warnings.some((w) => /pestañas/.test(w)));
});

test('validador: url(%23id) dentro de un data:image/svg+xml de CSS no es una referencia rota', () => {
  const { cssRefs } = require('../scripts/validate-download.js');
  const css =
    'a{background:url("data:image/svg+xml,<svg xmlns=\\"http://w\\"><g clip-path=\\"url(%23clip0_1)\\"><path fill=\\"%23F6F7F9\\"/></g></svg>") no-repeat;b:url(../x.png)}' +
    "d{src:url('f.woff2')}";
  const refs = cssRefs(css).filter((u) => !u.startsWith('data:'));
  assert.deepStrictEqual(refs, ['../x.png', 'f.woff2']);
});
