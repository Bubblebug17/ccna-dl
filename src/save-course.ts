import type { Page } from 'puppeteer';
import { mkdir, rename, writeFile } from 'fs/promises';
import { join } from 'path';
import sanitize = require('sanitize-filename');
import {
  buildIndexHtml,
  chapterFileName,
  entriesFromSavedChapters,
  IndexEntry,
  mergeIndexEntries,
  saveChapterHtml,
  SaveChapterResult,
} from './save-chapter-html';
import { AssetOptions, DEFAULT_ASSET_OPTIONS } from './download-assets';
import { CHAPTER_FORMAT, verifyChapterFile } from './verify-chapter';
import {
  ChapterOutcome,
  FAILURES_FILE,
  mergeFailures,
  readFailures,
  SUMMARY_FILE,
  totalsOf,
  writeRunFiles,
} from './run-summary';
import { urlToChapter as urlToChapterId } from './url-to-chapter-id';
import { backoffMs, fmtDuration, mapPool } from './util/retry';
import { delay } from './util/promise';
import { createProgress } from './progress';

export type SaveCourseOptions = {
  courseUrl: string;
  /** Omite capítulos ya guardados y verificados. */
  resume: boolean;
  /** Solo los capítulos de descarga-fallos.json. */
  retryFailed: boolean;
  /** Reintentos de capítulo (recargando la página) y de recursos. */
  retries: number;
  assetOpts: AssetOptions;
  /** Navega al capítulo y espera a que cargue (login/outline/spinners). */
  prepareChapter: (page: Page, chapterUrl: string) => Promise<void>;
  log?: (msg: string) => void;
  /**
   * Pestañas (páginas de puppeteer) que procesan capítulos a la vez, todas en el
   * mismo navegador y sesión. 1 (por defecto) = secuencial, como antes.
   */
  concurrency?: number;
  /** Crea una pestaña nueva del mismo contexto (cookies compartidas). Por defecto: `page.browserContext().newPage()`. */
  newPage?: () => Promise<Page>;
  /** Tiempo máximo por intento de capítulo (ms). Al agotarse se reinicia la pestaña y se reintenta. Por defecto 300 000. */
  chapterTimeoutMs?: number;
  /** Ctrl+C: no se empiezan capítulos nuevos; los que están en curso terminan de escribirse. */
  signal?: AbortSignal;
  /** Dibuja una barra de progreso (cli-progress) si la salida es una terminal. */
  progressBar?: boolean;
  /** prepareChapter ya hace el scroll completo (evita repetirlo al guardar). */
  prepareScrolls?: boolean;
};

export type SaveCourseResult = {
  siteDir: string;
  outcomes: ChapterOutcome[];
  failures: number;
  indexPath?: string;
  /** Se interrumpió (Ctrl+C) antes de procesar todos los capítulos. */
  aborted?: boolean;
  /** Capítulos sin procesar por la interrupción. */
  pending?: number;
};

export function chapterIdFromUrl(url: string): string {
  return urlToChapterId(url).replace(/\.1$/, '');
}

/** La pestaña se comporta como enfocada/visible aunque esté en segundo plano (carga diferida, rAF, temporizadores). */
async function emulateFocus(p: Page): Promise<void> {
  try {
    const cdp = await p.createCDPSession();
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  } catch {
    // opcional
  }
}

export const DEFAULT_CHAPTER_TIMEOUT_MS = 300_000;
const VIEWPORT = { width: 1400, height: 1200 };

const CRASH_RE = /target closed|session closed|protocol error|page crashed|has crashed|detached|execution context was destroyed|browser has disconnected|connection closed/i;
const SESSION_RE = /sesión no válida/i;

/** Duración legible: décimas por debajo de 10 s. */
function fmtMs(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : fmtDuration(ms);
}

class ChapterTimeout extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const t = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new ChapterTimeout(`tiempo agotado (${Math.round(ms / 1000)}s) ${what}`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

type Worker = { id: number; page: Page; own: boolean; retired: boolean; done: number };

/** Guarda los capítulos de un curso "launch" como HTML offline. */
export async function saveLaunchCourseSite(
  page: Page,
  urls: string[],
  courseId: string,
  courseTitle: string,
  outDir: string,
  opts: SaveCourseOptions
): Promise<SaveCourseResult> {
  const startedAt = new Date();
  const t0 = Date.now();

  const folderName = sanitize(`${courseId}_${courseTitle}`) || courseId;
  const siteDir = join(outDir, folderName);
  const chaptersDir = join(siteDir, 'chapters');
  await mkdir(chaptersDir, { recursive: true });
  await page.setViewport(VIEWPORT);

  const info = { courseId, courseTitle, courseUrl: opts.courseUrl };
  const previous = (await readFailures(siteDir))?.failures ?? [];

  // --retry-failed: solo los capítulos anotados como fallidos/parciales
  let todo = urls;
  const preLogs: string[] = [];
  if (opts.retryFailed) {
    const wanted = new Set(previous.map((f) => f.chapter));
    todo = urls.filter((u) => wanted.has(chapterIdFromUrl(u)));
    if (previous.length === 0) {
      preLogs.push(`No hay ${FAILURES_FILE} con capítulos pendientes en ${siteDir}. Nada que reintentar.`);
    } else {
      preLogs.push(`Reintentando ${todo.length} capítulo(s) fallido(s) de ${previous.length} anotados.`);
      const missing = previous.filter((f) => !todo.some((u) => chapterIdFromUrl(u) === f.chapter));
      if (missing.length) {
        preLogs.push(`  · ${missing.length} no aparecen ahora en el outline: ${missing.map((m) => m.chapter).join(', ')}`);
      }
    }
  }

  const lanes = Math.max(1, Math.min(Math.floor(opts.concurrency ?? 1) || 1, Math.max(1, todo.length)));
  const timeoutMs = opts.chapterTimeoutMs ?? DEFAULT_CHAPTER_TIMEOUT_MS;
  const progress = createProgress(todo.length, { enabled: opts.progressBar });
  const log = opts.log ?? progress.log;
  for (const l of preLogs) log(l);
  if (!opts.retryFailed) {
    log(
      `Guardando ${urls.length} capítulos como HTML en ${siteDir}` +
        (opts.resume ? ' (se omiten los ya verificados)' : ' (--force: se descarga todo)') +
        (lanes > 1 ? ` · ${lanes} pestañas en paralelo` : '')
    );
  }

  const outcomes: Array<ChapterOutcome | undefined> = new Array(todo.length);
  const entries: Array<IndexEntry | undefined> = new Array(todo.length);
  const downloaded = new Map<string, boolean>();
  const assetReasons = new Map<string, string>();
  const chapterAttempts = Math.min(Math.max(opts.retries, 0), 2) + 1;
  const tag = (idx: number) => `[${idx + 1}/${todo.length}] ${chapterIdFromUrl(todo[idx])}`;

  // ---- reanudación: se verifican en paralelo los capítulos ya guardados ----
  const queue: number[] = [];
  if (opts.resume && !opts.retryFailed) {
    const checks = await mapPool(todo, 8, async (u) =>
      verifyChapterFile(join(chaptersDir, chapterFileName(chapterIdFromUrl(u))), siteDir)
    );
    for (let idx = 0; idx < todo.length; idx++) {
      const chapter = chapterIdFromUrl(todo[idx]);
      const c = checks[idx];
      const v = c.ok ? c.value : undefined;
      if (v && v.ok && v.format >= CHAPTER_FORMAT) {
        log(`${tag(idx)} · omitido (ya guardado y verificado)`);
        outcomes[idx] = { chapter, url: todo[idx], status: 'omitido' };
        progress.tick();
        continue;
      }
      if (v && v.bytes > 0) {
        const why = !v.ok ? v.problems[0] : `formato antiguo (v${v.format}, faltan pestañas/fuentes)`;
        log(`${tag(idx)} · se vuelve a descargar: ${why}`);
      }
      queue.push(idx);
    }
  } else {
    for (let idx = 0; idx < todo.length; idx++) queue.push(idx);
  }

  // ---- pestañas de trabajo ----
  const makePage = opts.newPage ?? (() => page.browserContext().newPage());
  const workers: Worker[] = [{ id: 0, page, own: false, retired: false, done: 0 }];
  const prepareWorkerPage = async (p: Page) => {
    await p.setViewport(VIEWPORT).catch(() => undefined);
    // que la pestaña se comporte como visible/enfocada aunque esté en segundo plano (rAF, temporizadores, carga diferida)
    await emulateFocus(p);
  };
  const replacePage = async (w: Worker, why: string) => {
    log(`    · pestaña ${w.id + 1}: se reinicia (${why})`);
    const old = w.page;
    if (w.own) {
      await old.close().catch(() => undefined);
      w.page = await makePage();
      await prepareWorkerPage(w.page);
    } else if (old.isClosed()) {
      w.page = await makePage();
      w.own = true;
      await prepareWorkerPage(w.page);
    } else {
      // pestaña principal (sesión): no se cierra; se intenta dejarla en blanco
      await old.goto('about:blank').catch(() => undefined);
    }
  };

  const sumWorkMs = { v: 0 };
  let doneCount = 0;
  let doneMs = 0;
  let nextQ = 0;
  const requeue: number[] = [];
  let extraTabsDisabled = false;
  let aborted = false;

  const processChapter = async (w: Worker, idx: number): Promise<void> => {
    const chapterUrl = todo[idx];
    const chapter = chapterIdFromUrl(chapterUrl);
    const fileName = chapterFileName(chapter);
    const filePath = join(chaptersDir, fileName);
    const label = lanes > 1 ? `${tag(idx)} (pestaña ${w.id + 1})` : tag(idx);
    const tStart = Date.now();

    let res: SaveChapterResult | null = null;
    let lastError = '';
    let fullRecapture = false;
    for (let attempt = 1; attempt <= chapterAttempts; attempt++) {
      try {
        if (attempt > 1) {
          const wait = backoffMs(attempt - 2, 1000, 8000);
          log(`${label} · reintento ${attempt - 1}/${chapterAttempts - 1} en ${Math.round(wait / 1000)}s (${lastError})`);
          await delay(wait);
        }
        const wp = w.page;
        res = await withTimeout(
          (async () => {
            await opts.prepareChapter(wp, chapterUrl);
            let r = await saveChapterHtml(wp, filePath, siteDir, downloaded, chapter, opts.assetOpts, assetReasons, {
              prescrolled: !!opts.prepareScrolls,
            });
            // Carga sin terminar al guardar (loader/skeleton visible): recarga y re-captura UNA vez, con más paciencia.
            if (r.ok && r.incomplete && !fullRecapture) {
              fullRecapture = true;
              log(`${label} · carga sin terminar (${r.incomplete}); se recarga y se vuelve a capturar`);
              await opts.prepareChapter(wp, chapterUrl);
              const r2 = await saveChapterHtml(wp, filePath, siteDir, downloaded, chapter, opts.assetOpts, assetReasons, {
                prescrolled: !!opts.prepareScrolls,
                patient: true,
              });
              if (r2.ok) r = { ...r2, recaptured: true };
            }
            return r;
          })(),
          timeoutMs,
          `en el capítulo ${chapter}`
        );
        if (res.ok) break;
        lastError = res.problems.join('; ') || 'sin contenido';
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        res = null;
        // Una pestaña extra que no comparte sesión: se retira y el capítulo vuelve a la cola (sin gastar intento)
        if (w.id > 0 && SESSION_RE.test(lastError) && w.done === 0) {
          if (!extraTabsDisabled) {
            extraTabsDisabled = true;
            log(`    · las pestañas extra no comparten la sesión (${lastError}); se continúa con la pestaña principal`);
          }
          requeue.push(idx);
          w.retired = true;
          await w.page.close().catch(() => undefined);
          return;
        }
        if (e instanceof ChapterTimeout || CRASH_RE.test(lastError) || w.page.isClosed()) {
          await replacePage(w, e instanceof ChapterTimeout ? 'tiempo agotado' : 'la pestaña falló').catch((e2) => {
            lastError += ` (no se pudo reiniciar la pestaña: ${e2 instanceof Error ? e2.message : e2})`;
          });
        }
      }
    }

    const ms = Date.now() - tStart;
    sumWorkMs.v += ms;
    if (res && res.ok) {
      entries[idx] = {
        chapter,
        title: res.title || chapter,
        file: `chapters/${fileName}`,
        subtopics: res.subtopics,
      };
      const failedAssets = Object.entries(res.failedAssets);
      const tabsInfo = res.tabs.widgets ? `, pestañas ${res.tabs.captured}/${res.tabs.tabs}` : '';
      if (res.incomplete) {
        const reason = `captura posiblemente incompleta: ${res.incomplete}` + (failedAssets.length ? `; ${failedAssets.length} recursos fallidos` : '');
        log(`${label} · ⚠ parcial: ${reason} (${fmtMs(ms)})`);
        outcomes[idx] = {
          chapter,
          url: chapterUrl,
          status: 'parcial',
          reason,
          assets: res.assets,
          assetsFailed: failedAssets.length,
          failedAssets: failedAssets.map(([rel, why]) => `${rel} → ${why}`),
          ms,
        };
      } else if (failedAssets.length === 0 && res.warnings.length === 0) {
        log(`${label} · ✔ guardado (${res.assets} recursos${tabsInfo}, ${fmtMs(ms)})`);
        outcomes[idx] = { chapter, url: chapterUrl, status: 'guardado', assets: res.assets, assetsFailed: 0, ms };
      } else if (failedAssets.length === 0) {
        log(`${label} · ✔ guardado con avisos (${res.assets} recursos${tabsInfo}, ${fmtMs(ms)}): ${res.warnings.join(' | ')}`);
        outcomes[idx] = { chapter, url: chapterUrl, status: 'guardado', reason: res.warnings.join(' | '), assets: res.assets, assetsFailed: 0, ms };
      } else {
        const reason = `${failedAssets.length}/${res.assets} recursos no se descargaron: ${failedAssets[0][1]}`;
        log(`${label} · ⚠ parcial: ${reason} (${fmtMs(ms)})`);
        outcomes[idx] = {
          chapter,
          url: chapterUrl,
          status: 'parcial',
          reason,
          assets: res.assets,
          assetsFailed: failedAssets.length,
          failedAssets: failedAssets.map(([rel, why]) => `${rel} → ${why}`),
          ms,
        };
      }
    } else {
      log(`${label} · ✖ fallido: ${lastError} (${fmtMs(ms)})`);
      outcomes[idx] = { chapter, url: chapterUrl, status: 'fallido', reason: lastError, ms };
    }
    w.done++;
    doneMs += ms;
    doneCount++;
    progress.tick();
    const left = queue.length - doneCount;
    if (left > 0 && doneCount >= 2 && !process.stdout.isTTY) {
      const wall = (Date.now() - t0) / doneCount;
      log(`    progreso ${doneCount}/${queue.length} · ETA ~${fmtDuration(wall * left)}`);
    }
  };

  const takeNext = (): number | undefined => {
    if (opts.signal?.aborted) {
      aborted = true;
      return undefined;
    }
    if (requeue.length) return requeue.shift();
    return nextQ < queue.length ? queue[nextQ++] : undefined;
  };

  const runWorker = async (w: Worker) => {
    while (!w.retired) {
      const idx = takeNext();
      if (idx === undefined) {
        // otra pestaña puede devolver capítulos a la cola; esperar si todavía quedan en curso
        return;
      }
      try {
        await processChapter(w, idx);
      } catch (e) {
        // nunca debe pasar (processChapter captura todo); por seguridad, no perder el capítulo
        const chapter = chapterIdFromUrl(todo[idx]);
        const msg = e instanceof Error ? e.message : String(e);
        log(`${tag(idx)} · ✖ fallido: error interno: ${msg}`);
        outcomes[idx] = { chapter, url: todo[idx], status: 'fallido', reason: `error interno: ${msg}` };
        progress.tick();
      }
    }
  };

  try {
    if (lanes > 1) await emulateFocus(page);
    // pestañas adicionales (la 0 es la pestaña de la sesión)
    for (let i = 1; i < lanes && queue.length > 1; i++) {
      try {
        const p = await makePage();
        await prepareWorkerPage(p);
        workers.push({ id: i, page: p, own: true, retired: false, done: 0 });
      } catch (e) {
        log(`    · no se pudo abrir la pestaña ${i + 1}: ${e instanceof Error ? e.message : e}`);
        break;
      }
    }
    await Promise.all(workers.map((w) => runWorker(w)));
    // capítulos devueltos a la cola cuando ya no quedaban pestañas activas
    while (requeue.length && !opts.signal?.aborted) {
      await runWorker(workers[0]);
    }
  } finally {
    for (const w of workers) if (w.own) await w.page.close().catch(() => undefined);
    progress.stop();
  }

  const processed = outcomes.filter((o): o is ChapterOutcome => !!o);
  const pending = todo.length - processed.length;
  if (opts.signal?.aborted && pending > 0) aborted = true;

  // ---- índice: capítulos nuevos + los que ya estaban en disco (orden determinista) ----
  let indexPath: string | undefined;
  const fromDisk = await entriesFromSavedChapters(chaptersDir);
  const indexEntries = mergeIndexEntries(fromDisk, entries.filter((e): e is IndexEntry => !!e));
  if (indexEntries.length === 0) {
    log('No hay capítulos guardados. No se actualiza index.html para no borrar el índice anterior.');
  } else {
    indexPath = join(siteDir, 'index.html');
    const tmp = `${indexPath}.part`;
    await writeFile(tmp, buildIndexHtml(courseTitle, indexEntries), 'utf8');
    await rename(tmp, indexPath);
  }

  // ---- resumen + lista de fallos reintentables ----
  const failures = mergeFailures(previous, processed.filter((o) => o.status !== 'omitido'));
  const files = await writeRunFiles(siteDir, info, processed, failures, startedAt);
  const t = totalsOf(processed);
  const wallMs = Date.now() - t0;
  log('');
  log('════════ Resumen ════════');
  log(`Curso: ${courseTitle}`);
  log(`Capítulos: ${t.total} · guardados ${t.guardado} · omitidos ${t.omitido} · parciales ${t.parcial} · fallidos ${t.fallido}`);
  log(`Duración: ${fmtDuration(wallMs)}` + (workers.length > 1 && sumWorkMs.v > 0 ? ` (${workers.length} pestañas; suma de tiempos por capítulo ${fmtDuration(sumWorkMs.v)}, ganancia ×${(sumWorkMs.v / Math.max(1, wallMs)).toFixed(1)})` : ''));
  if (aborted) {
    log(`Interrumpido: ${pending} capítulo(s) sin procesar. Vuelve a ejecutar el mismo comando para continuar (se omiten los ya guardados).`);
  }
  for (const o of processed.filter((x) => x.status === 'parcial' || x.status === 'fallido')) {
    log(`  - ${o.chapter} [${o.status}] ${o.reason ?? ''}`);
  }
  if (failures.length) {
    log(`Pendientes: ${failures.length} capítulo(s) en ${files.failuresPath}`);
    log(`Para reintentar solo esos: ccna-dl --retry-failed <url-del-curso> --user <usuario>`);
  } else {
    log(`Sin fallos pendientes. Resumen: ${files.summaryPath}`);
  }
  if (indexPath) log(`Abre: ${indexPath}`);
  void SUMMARY_FILE;
  void doneMs;

  return { siteDir, outcomes: processed, failures: failures.length, indexPath, aborted, pending };
}
