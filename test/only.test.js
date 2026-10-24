'use strict';
// --only: parser de la expresión, caché del outline y mezcla de resumen/índice en ejecuciones parciales.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');
const { createFixture } = require('./fixture-server');
const { parseOnly, matchesOnly, modulesOfOnly, explicitChaptersOfOnly, wholeModulesOfOnly, describeOnly } = require('../lib/only-spec');
const oc = require('../lib/outline-cache');
const { mergeSummaryChapters, readSummary } = require('../lib/run-summary');
const { saveLaunchCourseSite, courseSiteDir } = require('../lib/save-course');
const { DEFAULT_ASSET_OPTIONS } = require('../lib/download-assets');

const CHROME = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
const FAST = { ...DEFAULT_ASSET_OPTIONS, retries: 1, backoffMs: 20, timeoutMs: 5000 };
const sel = (expr, chapters) => chapters.filter((c) => matchesOnly(parseOnly(expr), c));
const ALL = ['1.1', '2.0', '2.1', '2.2', '2.3', '2.4', '2.5', '3.1', '5.0', '5.2', '12.1'];

test('parseOnly: un capítulo, un módulo, listas y rangos', () => {
  assert.deepStrictEqual(sel('2.3', ALL), ['2.3']);
  assert.deepStrictEqual(sel('2', ALL), ['2.0', '2.1', '2.2', '2.3', '2.4', '2.5'], 'un módulo incluye 2.0 y todo X.Y');
  assert.deepStrictEqual(sel('2.1,2.3,5', ALL), ['2.1', '2.3', '5.0', '5.2']);
  assert.deepStrictEqual(sel('2.1-2.4', ALL), ['2.1', '2.2', '2.3', '2.4']);
  assert.deepStrictEqual(sel('2-3', ALL), ['2.0', '2.1', '2.2', '2.3', '2.4', '2.5', '3.1']);
  assert.deepStrictEqual(sel('2.4-3.1', ALL), ['2.4', '2.5', '3.1'], 'rango entre módulos');
  assert.deepStrictEqual(sel(' 2.1 , 2.1 ,12.1', ALL), ['2.1', '12.1'], 'espacios y duplicados');
  assert.deepStrictEqual(sel('1.1.1', ['1.1', '1.1.1']), ['1.1.1'], 'compatibilidad: id con .1 final');
  assert.deepStrictEqual(sel('1', ['1.1', '10.1', '11.2']), ['1.1'], '"1" no es "10"');
});

test('parseOnly: módulos implicados, ids explícitos y errores en español', () => {
  const s = parseOnly('2.1,2.3,5,7.2-7.4');
  assert.deepStrictEqual(modulesOfOnly(s), [2, 5, 7]);
  assert.deepStrictEqual(explicitChaptersOfOnly(s), ['2.1', '2.3']);
  assert.deepStrictEqual(wholeModulesOfOnly(parseOnly('2,3.1')), [2]);
  assert.match(describeOnly(parseOnly('2')), /módulo 2/);
  for (const bad of ['', '  ', 'abc', '2.', '2..1', '2.4-2.1', '4-2', '2.1-', ',', '2.x']) {
    assert.throws(() => parseOnly(bad), /--only/, `debería rechazar "${bad}"`);
  }
});

const V = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const url = (ch, n) => `https://x.test/launch?id=cid&tab=curriculum&view=${V(n)}&_chapter=${ch}`;

test('caché del outline: solo contesta cuando es seguro y se mezcla sin perder lo anterior', async () => {
  const now = new Date('2026-10-23T12:00:00Z');
  const full = oc.mergeOutlineCache(null, 'cid', oc.entriesFromUrls([url('1.1', 1), url('2.0', 2), url('2.1', 3), url('3.1', 4)]), { fullScan: true, wholeModules: [], now });
  assert.ok(full.complete);
  assert.deepStrictEqual(full.entries.map((e) => e.chapter), ['1.1', '2.0', '2.1', '3.1']);
  const get = (c, expr, t = now) => {
    const r = oc.chaptersFromCache(c, parseOnly(expr), t);
    return r ? r.map((e) => e.chapter) : null;
  };
  assert.deepStrictEqual(get(full, '2'), ['2.0', '2.1']);
  assert.strictEqual(get(full, '2.9'), null, 'capítulo explícito desconocido → hay que escanear');
  assert.strictEqual(get(full, '2', new Date('2026-12-30T00:00:00Z')), null, 'caché vieja (>30 días) → escanear');
  assert.strictEqual(oc.chaptersFromCache(null, parseOnly('2')), null);

  // caché parcial: solo el módulo 2 leído entero
  const part = oc.mergeOutlineCache(null, 'cid', oc.entriesFromUrls([url('2.0', 2), url('2.1', 3)]), { fullScan: false, wholeModules: [2], now });
  assert.ok(!part.complete);
  assert.deepStrictEqual(get(part, '2'), ['2.0', '2.1']);
  assert.strictEqual(get(part, '3'), null, 'módulo no leído → escanear');
  assert.deepStrictEqual(get(part, '2.1'), ['2.1']);

  // un --only posterior sobre otro módulo se suma sin perder el 2
  const more = oc.mergeOutlineCache(part, 'cid', oc.entriesFromUrls([url('3.1', 4)]), { fullScan: false, wholeModules: [3], now });
  assert.deepStrictEqual(more.entries.map((e) => e.chapter), ['2.0', '2.1', '3.1']);
  assert.deepStrictEqual(more.modules, [2, 3]);
  // releer entero el módulo 2 reemplaza (desaparece un capítulo que ya no existe)
  const re = oc.mergeOutlineCache(more, 'cid', oc.entriesFromUrls([url('2.1', 9)]), { fullScan: false, wholeModules: [2], now });
  assert.deepStrictEqual(re.entries.map((e) => `${e.chapter}`), ['2.1', '3.1']);
  assert.strictEqual(re.entries[0].viewId, V(9));

  // lectura/escritura en disco: atómica, valida courseId y descarta basura
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccna-oc-'));
  try {
    await oc.writeOutlineCache(dir, full);
    assert.ok(!fs.existsSync(path.join(dir, 'outline-cache.json.part')));
    assert.deepStrictEqual((await oc.readOutlineCache(dir, 'cid')).entries, full.entries);
    assert.strictEqual(await oc.readOutlineCache(dir, 'otro'), null, 'otro curso');
    fs.writeFileSync(path.join(dir, 'outline-cache.json'), '{no json');
    assert.strictEqual(await oc.readOutlineCache(dir, 'cid'), null, 'corrupta');
    fs.writeFileSync(path.join(dir, 'outline-cache.json'), JSON.stringify({ ...full, entries: [{ chapter: '2.1', viewId: '../../x' }] }));
    const bad = await oc.readOutlineCache(dir, 'cid');
    assert.strictEqual(bad ? bad.entries.length : 0, 0, 'view id no válido se descarta');
    assert.strictEqual(oc.chaptersFromCache(bad, parseOnly('2.1'), now), null);
    const body = fs.readFileSync(path.join(dir, 'outline-cache.json'), 'utf8');
    assert.ok(!/cookie|password|token/i.test(body));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mergeSummaryChapters: solo se sustituyen los capítulos tocados', () => {
  const o = (chapter, status) => ({ chapter, status });
  const prev = [o('1.1', 'guardado'), o('2.1', 'fallido'), o('2.2', 'guardado'), o('10.1', 'guardado')];
  const merged = mergeSummaryChapters(prev, [o('2.1', 'guardado'), o('2.2', 'omitido'), o('2.3', 'parcial')]);
  assert.deepStrictEqual(merged.map((c) => `${c.chapter}:${c.status}`), ['1.1:guardado', '2.1:guardado', '2.2:guardado', '2.3:parcial', '10.1:guardado']);
});

test('saveLaunchCourseSite con partial: no pierde el resto del curso en resumen e índice', async () => {
  const fx = await createFixture();
  const browser = await puppeteer.launch({ headless: true, executablePath: CHROME, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccna-only-'));
  try {
    const page = await browser.newPage();
    const urls = [`${fx.base}/launch1.html?_chapter=1.1.1`, `${fx.base}/launch2.html?_chapter=2.1.1`, `${fx.base}/launch3.html?_chapter=3.1.1`];
    const base = {
      courseUrl: 'http://x/course',
      resume: true,
      retryFailed: false,
      retries: 1,
      assetOpts: FAST,
      log: () => {},
      prepareChapter: async (p, u) => { await p.goto(u, { waitUntil: 'networkidle2' }); },
    };
    const r1 = await saveLaunchCourseSite(page, urls, 'cid', 'Curso de prueba', tmp, base);
    assert.strictEqual(r1.siteDir, courseSiteDir(tmp, 'cid', 'Curso de prueba'));
    const s1 = await readSummary(r1.siteDir);
    assert.strictEqual(s1.totals.total, 3);
    assert.ok(!s1.partial);
    const idx1 = fs.readFileSync(path.join(r1.siteDir, 'index.html'), 'utf8');
    const chaptersBefore = fs.readdirSync(path.join(r1.siteDir, 'chapters')).sort();
    const mtime = (f) => fs.statSync(path.join(r1.siteDir, 'chapters', f)).mtimeMs;
    const m1 = mtime('1.1.html');

    // --only 2.1 --force: se rehace solo 2.1
    await saveLaunchCourseSite(page, [urls[1]], 'cid', 'Curso de prueba', tmp, { ...base, resume: false, partial: true });
    const s2 = await readSummary(r1.siteDir);
    assert.strictEqual(s2.totals.total, 3, 'el resumen conserva los 3 capítulos');
    assert.ok(s2.partial);
    assert.deepStrictEqual(s2.chapters.map((c) => c.chapter), ['1.1', '2.1', '3.1']);
    assert.strictEqual(s2.chapters.find((c) => c.chapter === '1.1').status, s1.chapters.find((c) => c.chapter === '1.1').status, 'el resto no pasa a faltante/fallido');
    assert.strictEqual(mtime('1.1.html'), m1, 'no se reescribe lo que no se pidió');
    assert.deepStrictEqual(fs.readdirSync(path.join(r1.siteDir, 'chapters')).sort(), chaptersBefore, 'no se borra ningún capítulo');
    const idx2 = fs.readFileSync(path.join(r1.siteDir, 'index.html'), 'utf8');
    for (const ch of ['1.1', '2.1', '3.1']) {
      assert.ok(idx2.includes(`chapters/${ch}.html`), `el índice sigue enlazando ${ch}`);
      assert.ok(idx1.includes(`chapters/${ch}.html`));
    }

    // --only 2.1 sin --force: lo ya verificado se omite y no pisa su resultado anterior
    const r3 = await saveLaunchCourseSite(page, [urls[1]], 'cid', 'Curso de prueba', tmp, { ...base, partial: true });
    const s3 = await readSummary(r1.siteDir);
    assert.strictEqual(s3.totals.total, 3);
    assert.strictEqual(r3.outcomes.length, 1);
    await page.close();
  } finally {
    await browser.close();
    await fx.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
