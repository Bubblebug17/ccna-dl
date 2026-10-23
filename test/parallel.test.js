'use strict';
// Pruebas de la descarga en paralelo, las esperas por condición y la re-captura.
// Todo contra el servidor local (test/fixture-server.js): sin login, sin internet.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');
const { createFixture } = require('./fixture-server');
const { saveLaunchCourseSite } = require('../lib/save-course');
const { downloadAssets, DEFAULT_ASSET_OPTIONS } = require('../lib/download-assets');
const { verifyChapterFile } = require('../lib/verify-chapter');
const { gotoChapter, waitForChapterContent } = require('../lib/wait-for-chapter-content');
const { blockUnneededResources } = require('../lib/block-resources');
const { getWaitPolicy, setWaitPolicy, SAFE_POLICY, FAST_POLICY } = require('../lib/wait-policy');

const CHROME = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
const FAST = { ...DEFAULT_ASSET_OPTIONS, retries: 2, backoffMs: 20, timeoutMs: 5000 };

let fx, browser, tmp;
let seq = 0;

// Esperas cortas para que la batería no tarde minutos (los valores por defecto se prueban en unit.test.js y bench.js).
const TEST_POLICY = { minWaitMs: 300, stableMs: 250, maxStableMs: 3000, shellStableMs: 300, networkIdleMs: 200 };
function useTestPolicy(over = {}) {
  setWaitPolicy({});
  Object.assign(getWaitPolicy(), TEST_POLICY, over);
}

test.before(async () => {
  fx = await createFixture();
  browser = await puppeteer.launch({ headless: true, executablePath: CHROME, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccna-par-'));
});
test.after(async () => {
  await browser?.close();
  await fx?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});
test.beforeEach(() => useTestPolicy());

const walk = (d) =>
  fs.existsSync(d)
    ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
    : [];

const chapterUrl = (n, extra = 'clean=1') => `${fx.base}/launch?view=1&_chapter=${n}.1.1${extra ? '&' + extra : ''}`;
const urlsFor = (count, extra) => Array.from({ length: count }, (_, i) => chapterUrl(i + 1, extra));
const prepareChapter = async (p, u) => {
  await gotoChapter(p, u);
  await waitForChapterContent(p, u);
};
const newCtxPage = async () => {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  return page;
};
const baseOpts = (over = {}) => ({
  courseUrl: 'http://x/course',
  resume: true,
  retryFailed: false,
  retries: 1,
  assetOpts: FAST,
  prepareChapter,
  log: () => {},
  ...over,
});
const run = async (urls, outDir, over = {}, courseId = 'cid') => {
  const page = await newCtxPage();
  try {
    return await saveLaunchCourseSite(page, urls, courseId, 'Curso de prueba', outDir, baseOpts(over));
  } finally {
    await page.close().catch(() => {});
  }
};
const outDirFor = (name) => path.join(tmp, `${name}-${++seq}`);
const textOf = (f) => fs.readFileSync(f, 'utf8');
// Toda referencia local (../assets/...) de un capítulo debe existir en disco.
const missingRefs = (siteDir, file) => {
  const html = textOf(file);
  const refs = new Set([...html.matchAll(/\.\.\/assets\/[^"'()\s,<>\\]+/g)].map((m) => decodeURIComponent(m[0])));
  return [...refs].filter((r) => !fs.existsSync(path.join(siteDir, 'chapters', r)));
};

test('política de esperas: valores seguros por defecto y modo --fast opt-in', () => {
  assert.strictEqual(SAFE_POLICY.minWaitMs, 1500);
  assert.ok(FAST_POLICY.minWaitMs < SAFE_POLICY.minWaitMs);
  setWaitPolicy({});
  assert.strictEqual(getWaitPolicy().minWaitMs, 1500);
  assert.strictEqual(getWaitPolicy().fast, false);
  setWaitPolicy({ fast: true });
  assert.strictEqual(getWaitPolicy().fast, true);
  assert.strictEqual(getWaitPolicy().minWaitMs, FAST_POLICY.minWaitMs);
  setWaitPolicy({ minWaitMs: 2500 });
  assert.strictEqual(getWaitPolicy().minWaitMs, 2500);
  assert.strictEqual(getWaitPolicy().fast, false);
});

test('concurrencia: 3 pestañas producen los mismos archivos que 1 (y en el mismo orden de índice)', async () => {
  const N = 8;
  const seqDir = outDirFor('seq');
  const parDir = outDirFor('par');
  const r1 = await run(urlsFor(N), seqDir, { concurrency: 1 });
  const r3 = await run(urlsFor(N), parDir, { concurrency: 3 });
  assert.strictEqual(r1.outcomes.length, N);
  assert.strictEqual(r3.outcomes.length, N);
  assert.deepStrictEqual(r3.outcomes.map((o) => o.chapter), r1.outcomes.map((o) => o.chapter), 'salida determinista: orden de capítulos igual');
  assert.ok(r3.outcomes.every((o) => o.status === 'guardado'), JSON.stringify(r3.outcomes.map((o) => [o.chapter, o.status, o.reason])));
  const rel = (dir) => walk(dir).map((f) => path.relative(dir, f)).sort();
  // los nombres de assets son hash del contenido+URL: la lista debe ser idéntica
  assert.deepStrictEqual(rel(r3.siteDir), rel(r1.siteDir));
  assert.strictEqual(textOf(path.join(r3.siteDir, 'index.html')), textOf(path.join(r1.siteDir, 'index.html')), 'index.html idéntico');
  for (let i = 1; i <= N; i++) {
    const a = textOf(path.join(r1.siteDir, 'chapters', `${i}.1.html`));
    const b = textOf(path.join(r3.siteDir, 'chapters', `${i}.1.html`));
    assert.strictEqual(b, a, `capítulo ${i}.1 idéntico en secuencial y en paralelo`);
    assert.ok(a.includes(`CONTENIDO-CARGADO-${i}`));
    assert.deepStrictEqual(missingRefs(r3.siteDir, path.join(r3.siteDir, 'chapters', `${i}.1.html`)), [], `capítulo ${i}.1: recursos referenciados que faltan en disco`);
    const v = await verifyChapterFile(path.join(r3.siteDir, 'chapters', `${i}.1.html`), r3.siteDir);
    assert.ok(v.ok ?? v.problems.length === 0, v.problems.join('; '));
  }
  assert.ok(!walk(parDir).some((f) => /\.part$|\.tmp$/.test(f)), 'sin temporales');
});

test('caché de assets compartida: cada recurso común se pide UNA sola vez aunque haya 3 pestañas', async () => {
  const N = 9;
  fx.resetHits();
  const r = await run(urlsFor(N), outDirFor('cache'), { concurrency: 3 });
  assert.ok(r.outcomes.every((o) => o.status === 'guardado'));
  for (const shared of ['/css/style.css', '/img/ok.png', '/fonts/ciscosanstt-light.woff2', '/assets/files/lab_a_es-xl.pka']) {
    assert.ok((fx.dl[shared] || 0) <= 1, `${shared} pedido ${fx.dl[shared]} veces por el descargador (esperado ≤1)`);
  }
  assert.strictEqual(fx.dl['/img/ok.png'], 1);
  for (let i = 1; i <= N; i++) assert.strictEqual(fx.dl[`/img/u${i}.png`], 1, `u${i}.png único = 1 descarga`);
});

test('downloadAssets en paralelo desde varias pestañas: dedupe de descargas en curso, también de fallos', async () => {
  const siteDir = outDirFor('dedupe');
  fs.mkdirSync(siteDir, { recursive: true });
  const pages = await Promise.all([newCtxPage(), newCtxPage(), newCtxPage()]);
  const done = new Map();
  const okUrl = `${fx.base}/img/ok.png`;
  const badUrl = `${fx.base}/img/down.png`;
  fx.resetHits();
  const results = await Promise.all(
    pages.map((p) => downloadAssets(p, { [okUrl]: 'assets/img/ok.png', [badUrl]: 'assets/img/down.png' }, siteDir, done, { ...FAST, retries: 1 }))
  );
  await Promise.all(pages.map((p) => p.close()));
  assert.strictEqual(fx.dl['/img/ok.png'], 1, 'ok.png solo una vez');
  assert.ok(fx.dl['/img/down.png'] <= 2, `down.png: 1 intento + 1 reintento como mucho, no ×3 (fue ${fx.dl['/img/down.png']})`);
  for (const r of results) assert.ok(r.failed.has('assets/img/down.png'), 'todas las pestañas ven el fallo');
  assert.ok(walk(siteDir).some((f) => /ok\.png$/.test(f)));
});

test('esperas por condición: un esqueleto de carga de 2 s se espera, no se guarda a medias', async () => {
  useTestPolicy({ maxStableMs: 5000 });
  const outDir = outDirFor('skeleton');
  const r = await run([chapterUrl(1, 'clean=1&slow=2000')], outDir, { concurrency: 1 });
  const o = r.outcomes[0];
  assert.strictEqual(o.status, 'guardado', JSON.stringify(o));
  const html = textOf(path.join(r.siteDir, 'chapters', '1.1.html'));
  assert.ok(html.includes('CONTENIDO-CARGADO-1'), 'contenido real presente');
  assert.ok(!html.includes('skeleton-box'), 'sin esqueleto en el HTML guardado');
  assert.ok(!html.includes('ccna-dl-incomplete'));
});

test('carga que no termina: se re-captura una vez y se marca parcial; --resume lo rehace', async () => {
  useTestPolicy({ maxStableMs: 800 });
  const outDir = outDirFor('sticky');
  const logs = [];
  const urls = [chapterUrl(1, 'clean=1'), chapterUrl(2, 'clean=1&sticky=1')];
  fx.resetHits();
  const r = await run(urls, outDir, { concurrency: 2, log: (m) => logs.push(m) });
  const byCh = Object.fromEntries(r.outcomes.map((o) => [o.chapter, o]));
  assert.strictEqual(byCh['1.1'].status, 'guardado');
  assert.strictEqual(byCh['2.1'].status, 'parcial', JSON.stringify(byCh['2.1']));
  assert.match(byCh['2.1'].reason || '', /carga|incomplet|sin terminar/i);
  assert.ok(logs.some((l) => /carga sin terminar/.test(l) && /recarga/.test(l)), 're-captura anunciada');
  assert.ok((fx.hits['/authoring-resources/ch2.html'] || 0) >= 2, 'el capítulo se volvió a cargar al menos una vez');
  const html2 = textOf(path.join(r.siteDir, 'chapters', '2.1.html'));
  assert.deepStrictEqual(missingRefs(r.siteDir, path.join(r.siteDir, 'chapters', '2.1.html')), [], 'la re-captura conserva todos los recursos');
  assert.match(html2, /ccna-dl-incomplete/, 'marca de incompleto en el HTML');
  const v = await verifyChapterFile(path.join(r.siteDir, 'chapters', '2.1.html'), r.siteDir);
  assert.ok(v.problems.length > 0, 'el validador lo rechaza');
  const fails = JSON.parse(textOf(path.join(r.siteDir, 'descarga-fallos.json')));
  assert.ok(fails.failures.some((f) => f.chapter === '2.1'));

  // reanudar: el 1.1 se omite, el 2.1 se rehace
  const r2 = await run(urls, outDir, { concurrency: 2 });
  const b2 = Object.fromEntries(r2.outcomes.map((o) => [o.chapter, o.status]));
  assert.strictEqual(b2['1.1'], 'omitido');
  assert.notStrictEqual(b2['2.1'], 'omitido', 'el incompleto no se da por bueno');
});

test('reanudación con paralelismo: omite lo verificado y rehace solo lo borrado o corrupto', async () => {
  const outDir = outDirFor('resume');
  const urls = urlsFor(6);
  const r1 = await run(urls, outDir, { concurrency: 3 });
  assert.ok(r1.outcomes.every((o) => o.status === 'guardado'));

  fx.resetHits();
  const r2 = await run(urls, outDir, { concurrency: 3 });
  assert.ok(r2.outcomes.every((o) => o.status === 'omitido'), JSON.stringify(r2.outcomes.map((o) => o.status)));
  assert.ok(!fx.hits['/launch'], 'no se abre ningún capítulo al reanudar (verificación local)');

  // borrar uno y truncar otro
  fs.rmSync(path.join(r1.siteDir, 'chapters', '2.1.html'));
  const f5 = path.join(r1.siteDir, 'chapters', '5.1.html');
  fs.writeFileSync(f5, textOf(f5).slice(0, 300));
  const r3 = await run(urls, outDir, { concurrency: 3 });
  const st = Object.fromEntries(r3.outcomes.map((o) => [o.chapter, o.status]));
  assert.deepStrictEqual(Object.keys(st).filter((k) => st[k] !== 'omitido').sort(), ['2.1', '5.1']);
  assert.strictEqual(st['2.1'], 'guardado');
  assert.strictEqual(st['5.1'], 'guardado');
});

test('tiempo límite por capítulo: una pestaña colgada se reinicia y el capítulo se reintenta', async () => {
  const outDir = outDirFor('timeout');
  const logs = [];
  // el 2.1 se cuelga en la primera petición (hang=1) y responde en la segunda
  const urls = [chapterUrl(1), chapterUrl(2, 'clean=1&hang=1'), chapterUrl(3), chapterUrl(4)];
  const r = await run(urls, outDir, { concurrency: 2, chapterTimeoutMs: 4000, retries: 1, log: (m) => logs.push(m) });
  assert.ok(r.outcomes.every((o) => o.status === 'guardado'), JSON.stringify(r.outcomes.map((o) => [o.chapter, o.status, o.reason])));
  assert.ok(logs.some((l) => /tiempo|reinicia/i.test(l)), 'consta el reinicio/timeout: ' + logs.join('\n'));
  assert.ok(textOf(path.join(r.siteDir, 'chapters', '2.1.html')).includes('CONTENIDO-CARGADO-2'));
});

test('pestaña caída: se abre una nueva y el capítulo se reintenta', async () => {
  const outDir = outDirFor('crash');
  const logs = [];
  let crashed = false;
  const r = await run(urlsFor(5), outDir, {
    concurrency: 2,
    retries: 1,
    log: (m) => logs.push(m),
    prepareChapter: async (p, u) => {
      if (!crashed && /_chapter=3\./.test(u)) {
        crashed = true;
        await p.close(); // simula que la pestaña muere en mitad del capítulo
      }
      await prepareChapter(p, u);
    },
  });
  assert.ok(crashed);
  assert.ok(r.outcomes.every((o) => o.status === 'guardado'), JSON.stringify(r.outcomes.map((o) => [o.chapter, o.status, o.reason])));
  assert.ok(logs.some((l) => /se reinicia/.test(l)), 'consta el reinicio de la pestaña');
});

test('Ctrl+C: no se empiezan capítulos nuevos, nada queda a medias y se puede reanudar', async () => {
  const outDir = outDirFor('abort');
  const ac = new AbortController();
  const urls = urlsFor(10);
  const r1 = await run(urls, outDir, {
    concurrency: 2,
    signal: ac.signal,
    log: (m) => {
      if (/✔ guardado/.test(m)) ac.abort();
    },
  });
  assert.strictEqual(r1.aborted, true);
  assert.ok(r1.pending > 0 && r1.pending < 10, 'pending=' + r1.pending);
  const files = walk(r1.siteDir);
  assert.ok(!files.some((f) => /\.part$|\.tmp$/.test(f)), 'sin temporales');
  const chapters = files.filter((f) => /chapters[\\/][^\\/]+\.html$/.test(f));
  assert.ok(chapters.length >= 1 && chapters.length <= 4);
  for (const f of chapters) {
    const v = await verifyChapterFile(f, r1.siteDir);
    assert.ok(v.problems.length === 0, f + ': ' + v.problems.join('; '));
  }
  assert.ok(fs.existsSync(path.join(r1.siteDir, 'index.html')), 'índice escrito con lo ya guardado');
  const r2 = await run(urls, outDir, { concurrency: 3 });
  assert.strictEqual(r2.outcomes.length, 10);
  assert.ok(r2.outcomes.every((o) => o.status === 'omitido' || o.status === 'guardado'));
  assert.strictEqual(r2.outcomes.filter((o) => o.status === 'omitido').length, chapters.length, 'se omiten los ya guardados');
});

test('bloqueo de trackers por CDP: la petición no llega al servidor', async () => {
  const p1 = await newCtxPage();
  fx.resetHits();
  await p1.goto(chapterUrl(1), { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(fx.hits['/blocked-tracker/t.js'] >= 1, 'sin bloqueo, el tracker se pide');
  await p1.close();

  const p2 = await newCtxPage();
  const stats = await blockUnneededResources(p2, ['*blocked-tracker*']);
  assert.ok(stats, 'bloqueo activado');
  fx.resetHits();
  await p2.goto(chapterUrl(1), { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!fx.hits['/blocked-tracker/t.js'], 'con bloqueo, no llega');
  assert.ok(stats.blocked >= 1);
  assert.ok(fx.hits['/img/ok.png'] >= 1, 'el resto sí carga');
  await p2.close();
});

// ---------- memoria: reciclado de pestañas, bloqueo de medios, plan de pestañas ----------
const { planTabs, DEFAULT_TABS, TAB_BUDGET_MB, RESERVE_MB } = require('../lib/memory');
const { MEDIA_PATTERNS } = require('../lib/block-resources');

test('reciclado de pestañas: mismo resultado, pestañas reabiertas y ninguna fuga de pestañas', async () => {
  const N = 9;
  const baseline = outDirFor('rc-base');
  const rb = await run(urlsFor(N), baseline, { concurrency: 2, recycleEvery: 0, recycleHeapMb: 0, freeMemMb: () => 99999 });
  let created = 0;
  const before = (await browser.pages()).length;
  const logs = [];
  const dir = outDirFor('rc');
  const r = await run(urlsFor(N), dir, {
    concurrency: 2,
    recycleEvery: 2,
    recycleHeapMb: 0,
    freeMemMb: () => 99999,
    log: (m) => logs.push(m),
    newPage: async () => {
      created++;
      return newCtxPage();
    },
  });
  assert.ok(r.outcomes.every((o) => o.status === 'guardado'), JSON.stringify(r.outcomes.map((o) => [o.chapter, o.status, o.reason])));
  assert.ok(created > 1, `se esperaban pestañas reabiertas, creadas=${created}`);
  assert.ok(logs.some((l) => /reciclada \(cada 2 capítulos\)/.test(l)), 'el log informa del reciclado');
  for (let i = 1; i <= N; i++) {
    assert.strictEqual(textOf(path.join(r.siteDir, 'chapters', `${i}.1.html`)), textOf(path.join(rb.siteDir, 'chapters', `${i}.1.html`)), `capítulo ${i}.1 idéntico con y sin reciclado`);
  }
  assert.strictEqual(textOf(path.join(r.siteDir, 'index.html')), textOf(path.join(rb.siteDir, 'index.html')));
  assert.strictEqual((await browser.pages()).length, before, 'no quedan pestañas abiertas');
});

test('reciclado por heap de JS y por poca RAM libre; recycleEvery 0 lo desactiva', async () => {
  const N = 6;
  let c1 = 0;
  const l1 = [];
  const r1 = await run(urlsFor(N), outDirFor('rc-heap'), {
    concurrency: 2, recycleEvery: 0, recycleHeapMb: 1, freeMemMb: () => 99999, log: (m) => l1.push(m),
    newPage: async () => (c1++, newCtxPage()),
  });
  assert.ok(r1.outcomes.every((o) => o.status === 'guardado'));
  assert.ok(l1.some((l) => /reciclada \(heap de JS/.test(l)), 'recicla por heap');
  let c2 = 0;
  const l2 = [];
  const r2 = await run(urlsFor(N), outDirFor('rc-ram'), {
    concurrency: 2, recycleEvery: 0, recycleHeapMb: 0, freeMemMb: () => 100, log: (m) => l2.push(m),
    newPage: async () => (c2++, newCtxPage()),
  });
  assert.ok(r2.outcomes.every((o) => o.status === 'guardado'));
  assert.ok(l2.some((l) => /reciclada \(poca RAM libre/.test(l)), 'recicla por poca RAM');
  let c3 = 0;
  const l3 = [];
  await run(urlsFor(N), outDirFor('rc-off'), {
    concurrency: 2, recycleEvery: 0, recycleHeapMb: 0, freeMemMb: () => 99999, log: (m) => l3.push(m),
    newPage: async () => (c3++, newCtxPage()),
  });
  assert.strictEqual(c3, 1, 'sin reciclado solo se abre la pestaña extra inicial');
  assert.ok(!l3.some((l) => /reciclada/.test(l)));
});

test('reciclado de la pestaña de sesión (una sola pestaña): se vacía sin cerrarla y sigue funcionando', async () => {
  const page = await newCtxPage();
  const logs = [];
  const r = await saveLaunchCourseSite(page, urlsFor(5), 'cid', 'Curso de prueba', outDirFor('rc1'), baseOpts({ concurrency: 1, recycleEvery: 2, recycleHeapMb: 0, freeMemMb: () => 99999, log: (m) => logs.push(m) }));
  assert.ok(!page.isClosed(), 'la pestaña de la sesión no se cierra');
  await page.close();
  assert.ok(r.outcomes.every((o) => o.status === 'guardado'));
  assert.ok(logs.filter((l) => /reciclada/.test(l)).length >= 2);
});

test('medios bloqueados por defecto: el navegador no pide el mp4, Node sí lo descarga, el capítulo se guarda completo', async () => {
  const page = await newCtxPage();
  await blockUnneededResources(page, MEDIA_PATTERNS);
  fx.resetHits();
  const dir = outDirFor('media');
  const r = await saveLaunchCourseSite(page, urlsFor(2, 'clean=1&heavy=1'), 'cid', 'Curso de prueba', dir, baseOpts({ concurrency: 1 }));
  await page.close();
  assert.ok(r.outcomes.every((o) => o.status === 'guardado'), JSON.stringify(r.outcomes.map((o) => [o.chapter, o.status, o.reason])));
  for (const n of [1, 2]) {
    const k = `/media/clip${n}.mp4`;
    assert.strictEqual((fx.hits[k] || 0) - (fx.dl[k] || 0), 0, `${k}: el navegador no debe pedirlo (hits=${fx.hits[k]}, node=${fx.dl[k]})`);
    assert.ok(textOf(path.join(r.siteDir, 'chapters', `${n}.1.html`)).includes('CONTENIDO-CARGADO-' + n));
  }
});

test('planTabs: por defecto min(2, RAM) y aviso cuando N pestañas no caben', () => {
  const GB = 1024;
  assert.strictEqual(DEFAULT_TABS, 2);
  assert.strictEqual(planTabs(undefined, { freeMb: 12 * GB, totalMb: 16 * GB }).tabs, 2);
  assert.strictEqual(planTabs(undefined, { freeMb: 12 * GB, totalMb: 16 * GB }).warn, undefined);
  assert.strictEqual(planTabs(undefined, { freeMb: 1 * GB, totalMb: 15 * GB }).tabs, 1, 'poca RAM libre: 1 pestaña');
  assert.strictEqual(planTabs(undefined, { freeMb: RESERVE_MB + TAB_BUDGET_MB, totalMb: 8 * GB }).tabs, 1);
  const explicit = planTabs(3, { freeMb: 1 * GB, totalMb: 15 * GB });
  assert.strictEqual(explicit.tabs, 3, 'un valor explícito se respeta');
  assert.match(explicit.warn, /Memoria: .*3 pestañas.*--concurrency 1/);
  assert.strictEqual(planTabs(3, { freeMb: 12 * GB, totalMb: 16 * GB }).warn, undefined);
  assert.strictEqual(planTabs(1, { freeMb: 500, totalMb: 8 * GB }).warn, undefined);
  assert.strictEqual(planTabs(99, { freeMb: 64 * GB, totalMb: 64 * GB }).tabs, 6);
  assert.strictEqual(planTabs(0, { freeMb: 64 * GB, totalMb: 64 * GB }).tabs, 1);
});
