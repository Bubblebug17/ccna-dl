'use strict';
// Benchmark de MEMORIA (solo con el servidor local de pruebas, sin login ni internet).
// Lanza su propio Chrome y suma el RSS de ese Chrome y sus hijos (nunca toca otros procesos).
//   node test/bench-mem.js [--chapters 12] [--conc 2] [--scenarios antes,ahora]   (también antes:3,ahora:2 = nombre:pestañas)
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');
const { createFixture } = require('./fixture-server');
const { saveLaunchCourseSite } = require('../lib/save-course');
const { DEFAULT_ASSET_OPTIONS } = require('../lib/download-assets');
const { gotoChapter, waitForChapterContent } = require('../lib/wait-for-chapter-content');
const { blockUnneededResources, TRACKER_PATTERNS, MEDIA_PATTERNS } = require('../lib/block-resources');
const { chromeLaunchArgs } = require('../lib/browser-args');
const { setWaitPolicy, getWaitPolicy } = require('../lib/wait-policy');
const { watch } = require('./memwatch');

const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i > 0 ? process.argv[i + 1] : d;
};
const CHAPTERS = Number(arg('chapters', 12));
const CONC = Number(arg('conc', 2));
const SCEN = arg('scenarios', 'antes,ahora').split(',');
const CHROME = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

const OLD_ARGS = ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-features=IsolateOrigins,site-per-process', '--window-size=1400,900'];

async function run(fx, spec) {
  const [name, c] = spec.split(':');
  const conc = Number(c || CONC);
  const now = name !== 'antes';
  const args = ['--no-sandbox', '--disable-setuid-sandbox', ...(now ? chromeLaunchArgs({}) : OLD_ARGS)];
  const browser = await puppeteer.launch({ headless: true, executablePath: CHROME, args });
  const pid = browser.process().pid;
  const patterns = now && process.env.BLOCK_MEDIA ? [...TRACKER_PATTERNS, ...MEDIA_PATTERNS] : TRACKER_PATTERNS; // el bloqueo de medios es opcional (--no-videos)
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ccna-mem-'));
  const mk = async () => {
    const p = await browser.newPage();
    await p.setViewport({ width: 1400, height: 1200 });
    await blockUnneededResources(p, patterns);
    return p;
  };
  const page = await mk();
  const urls = Array.from({ length: CHAPTERS }, (_, i) => `${fx.base}/launch?view=1&_chapter=${i + 1}.1.1&clean=1&heavy=1`);
  fx.resetHits();
  const w = watch(pid);
  const t0 = Date.now();
  const res = await saveLaunchCourseSite(page, urls, 'mem', 'Curso memoria', out, {
    courseUrl: 'http://x/course',
    resume: false,
    retries: 1,
    concurrency: conc,
    newPage: mk,
    recycleEvery: now ? 6 : 0,
    recycleHeapMb: now ? 600 : 0,
    freeMemMb: () => 99999,
    progressBar: false,
    log: () => {},
    prepareScrolls: true,
    prepareChapter: async (p, u) => {
      await gotoChapter(p, u);
      await waitForChapterContent(p, u);
    },
    assetOpts: { ...DEFAULT_ASSET_OPTIONS, retries: 1, backoffMs: 20, timeoutMs: 20000 },
  });
  const ms = Date.now() - t0;
  const m = w.stop();
  const st = res.outcomes.reduce((a, o) => ((a[o.status] = (a[o.status] || 0) + 1), a), {});
  const mp4 = Object.keys(fx.hits).filter((k) => k.endsWith('.mp4')).length;
  await browser.close();
  fs.rmSync(out, { recursive: true, force: true });
  return { name, conc, ms, peak: m.peakMb, last: m.lastMb, procs: m.peakProcs, st, mp4 };
}

(async () => {
  setWaitPolicy({});
  Object.assign(getWaitPolicy(), { minWaitMs: 300, stableMs: 250, maxStableMs: 3000, shellStableMs: 300, networkIdleMs: 200 });
  const fx = await createFixture();
  console.log(`Memoria Chrome (suma RSS de Chrome y sus hijos, solo procesos propios): ${CHAPTERS} capítulos pesados (6 imágenes 2600×2600 + vídeo)`);
  for (const s of SCEN) {
    const r = await run(fx, s);
    console.log(`${(r.name + ' c=' + r.conc).padEnd(10)} pico ${r.peak.toFixed(0).padStart(5)} MB · final ${r.last.toFixed(0).padStart(5)} MB · procesos (pico) ${r.procs} · ${(r.ms / 1000).toFixed(1)} s · ${JSON.stringify(r.st)} · peticiones .mp4 al servidor desde Chrome+Node: ${r.mp4}`);
  }
  await fx.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
