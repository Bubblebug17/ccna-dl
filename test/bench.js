'use strict';
// Benchmark sobre el servidor local con latencia simulada. NO toca internet.
//   node test/bench.js [--chapters 12] [--latency 120] [--slow 1500] [--old ruta/a/lib-anterior] [--scenarios old,1,3,6,fast3]
// Usa las esperas POR DEFECTO (seguras: --min-wait 1500). `--old` compara con una compilación anterior (descarga secuencial).
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');
const { createFixture } = require('./fixture-server');

const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i > 0 ? process.argv[i + 1] : d;
};
const CHAPTERS = +arg('chapters', 12);
const LATENCY = +arg('latency', 120);
const SLOW = +arg('slow', 1500);
const OLD = arg('old', '');
const SCEN = arg('scenarios', (OLD ? 'old,' : '') + '1,3,6,fast3').split(',');
const CHROME = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

function load(libDir) {
  const r = (m) => require(path.resolve(libDir, m));
  return {
    save: r('save-course').saveLaunchCourseSite,
    goto: r('wait-for-chapter-content').gotoChapter,
    wait: r('wait-for-chapter-content').waitForChapterContent,
    spin: r('wait-for-spinners').waitForSpinners,
    assets: r('download-assets').DEFAULT_ASSET_OPTIONS,
    policy: (() => { try { return r('wait-policy'); } catch { return null; } })(),
  };
}

async function runScenario(fx, browser, name) {
  const isOld = name === 'old';
  const lib = load(isOld ? OLD : path.join(__dirname, '..', 'lib'));
  const conc = isOld ? 1 : +name.replace('fast', '');
  if (lib.policy) lib.policy.setWaitPolicy({ fast: name.startsWith('fast') });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-'));
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  const urls = Array.from({ length: CHAPTERS }, (_, i) => `${fx.base}/launch?view=1&_chapter=${i + 1}.1.1&clean=1&slow=${SLOW}`);
  fx.resetHits();
  const t0 = Date.now();
  const opts = {
    courseUrl: 'http://x/course',
    resume: false,
    retryFailed: false,
    retries: 1,
    assetOpts: { ...lib.assets, concurrency: 6 },
    log: () => {},
    prepareChapter: async (p, u) => {
      await lib.goto(p, u);
      await lib.wait(p, u);
      await lib.spin(p).catch(() => undefined);
    },
  };
  if (!isOld) Object.assign(opts, { concurrency: conc, prepareScrolls: false });
  const res = await lib.save(page, urls, 'cid', 'Bench', out, opts);
  const ms = Date.now() - t0;
  let skeleton = 0;
  let loaded = 0;
  for (let i = 1; i <= CHAPTERS; i++) {
    const f = path.join(res.siteDir, 'chapters', `${i}.1.html`);
    if (!fs.existsSync(f)) continue;
    const h = fs.readFileSync(f, 'utf8');
    if (h.includes('skeleton-box')) skeleton++;
    if (h.includes(`CONTENIDO-CARGADO-${i}`)) loaded++;
  }
  const st = res.outcomes.reduce((a, o) => ((a[o.status] = (a[o.status] || 0) + 1), a), {});
  await page.close().catch(() => {});
  fs.rmSync(out, { recursive: true, force: true });
  return { name: isOld ? 'ANTES (secuencial, esperas fijas)' : `AHORA --concurrency ${conc}${name.startsWith('fast') ? ' --fast' : ''}`, ms, st, loaded, skeleton, perChapter: ms / CHAPTERS };
}

(async () => {
  const fx = await createFixture({ latencyMs: LATENCY });
  const browser = await puppeteer.launch({ headless: true, executablePath: CHROME, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
  console.log(`Benchmark local: ${CHAPTERS} capítulos, latencia simulada ${LATENCY} ms por petición, efecto de carga (esqueleto) ${SLOW} ms`);
  const rows = [];
  for (const s of SCEN) {
    const r = await runScenario(fx, browser, s);
    rows.push(r);
    console.log(`${r.name.padEnd(36)} ${(r.ms / 1000).toFixed(1).padStart(6)} s  (${(r.perChapter / 1000).toFixed(2)} s/cap)  completos ${r.loaded}/${CHAPTERS}  con esqueleto ${r.skeleton}  ${JSON.stringify(r.st)}`);
  }
  const base = rows[0].ms;
  console.log('\nGanancia respecto a la primera fila: ' + rows.map((r) => `${r.name.split(' ').slice(-2).join(' ')} ×${(base / r.ms).toFixed(2)}`).join(' · '));
  await browser.close();
  await fx.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
