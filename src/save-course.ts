import type { Page } from 'puppeteer';
import { cleanTitle } from './ui/titles';
import { mkdir, rename, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
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
import { AssetOptions } from './download-assets';
import { chapterUpToDate, verifyChapterFile } from './verify-chapter';
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
import { dedupeByFileId } from './chapter-ids';
import { backoffMs, fmtDuration, mapPool } from './util/retry';
import { delay } from './util/promise';
import { createProgress } from './progress';
import { isFontUrl, shortError, shortWarnings } from './warnings';
import { logFilePath, setLogFile } from './ui/log';
import { DEFAULT_RECYCLE_EVERY, DEFAULT_RECYCLE_HEAP_MB, recycleReason } from './memory';

export type SaveCourseOptions = {
  courseUrl: string;
  /** Omite capítulos ya guardados y verificados. */
  resume: boolean;
  /** Solo los capítulos de descarga-fallos.json. */
  retryFailed: boolean;
  /**
   * Ejecución parcial (--only): `urls` es solo una parte del curso. El resumen se MEZCLA con el existente
   * (no se pierde el resto) y el índice se completa con lo que ya hay en disco (siempre es así).
   */
  partial?: boolean;
  /** Reintentos de capítulo (recargando la página) y de recursos. */
  retries: number;
  assetOpts: AssetOptions;
  /** Navega al capítulo y espera a que cargue (login/outline/spinners). */
  prepareChapter: (page: Page, chapterUrl: string) => Promise<void>;
  log?: (msg: string, level?: 1 | 2 | 3, kind?: 'info' | 'ok' | 'warn' | 'error') => void;
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
  /**
   * Recicla (cierra y reabre) la pestaña de cada worker cada N capítulos para que el renderer
   * no acumule memoria durante toda la descarga. 0 = nunca. Por defecto 8.
   * La pestaña de la sesión (la primera) no se cierra: se deja en about:blank.
   */
  recycleEvery?: number;
  /** Heap de JS (MB) que dispara un reciclado anticipado de la pestaña. Por defecto 600; 0 = desactivado. */
  recycleHeapMb?: number;
  /** Para pruebas: RAM libre (MB) simulada. */
  freeMemMb?: () => number;
  /** Activa los reproductores de vídeo y guarda vídeo + subtítulos (por defecto sí; false = --no-videos). */
  videos?: boolean;
  /** Graba las animaciones interactivas (canvas + play + deslizador) para verlas sin conexión (por defecto sí; false = --no-animations). */
  animations?: boolean;
  /** Guarda `debug/red-<capítulo>.json` por capítulo (peticiones sin cookies/tokens + componentes detectados). */
  debugNetwork?: boolean;
  /** Tiempo máximo de grabación por animación (ms). */
  animationMaxMs?: number;
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

/** Carpeta del curso (misma regla que usa saveLaunchCourseSite). */
export function courseSiteDir(outDir: string, courseId: string, courseTitle: string): string {
  return join(outDir, sanitize(`${courseId}_${courseTitle}`) || courseId);
}

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

/** Registro detallado de cada ejecución, en la carpeta del curso. */
export const LOG_FILE = 'ccna-dl.log';

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

type Worker = { id: number; page: Page; own: boolean; retired: boolean; done: number; since: number };

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

  const siteDir = resolve(courseSiteDir(outDir, courseId, courseTitle));
  const chaptersDir = join(siteDir, 'chapters');
  await mkdir(chaptersDir, { recursive: true });
  await page.setViewport(VIEWPORT);

  // dos URLs con el mismo id de archivo (p. ej. 2.2 y 2.2.1) se pisarían: nos quedamos con la sección real
  const dedup = dedupeByFileId(urls, urlToChapterId);
  urls = dedup.urls;

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
  // detalles (URLs, códigos, errores completos) en <carpeta del curso>/ccna-dl.log
  const ownLogFile = !opts.log && !logFilePath();
  if (ownLogFile) setLogFile(join(siteDir, LOG_FILE));
  const progress = createProgress(todo.map(chapterIdFromUrl), { enabled: opts.progressBar && !opts.log });
  const log = opts.log ?? progress.log;
  const warn = (m: string) => log(m, 1, 'warn');
  const fail = (m: string) => log(m, 1, 'error');
  const ok = (m: string, lvl: 1 | 2 | 3 = 2) => log(m, lvl, 'ok');
  const detail = (m: string) => log(m, 3, 'info');
  // títulos ya conocidos (capítulos guardados antes): para las barras
  const known = new Map<string, string>();
  for (const e of await entriesFromSavedChapters(chaptersDir).catch(() => [] as IndexEntry[])) {
    known.set(e.chapter, e.title);
    progress.setTitle(e.chapter, e.title);
  }
  const name = (ch: string) => (known.get(ch) ? `${ch} ${cleanTitle(ch, known.get(ch)) || known.get(ch)}` : ch);
  // recursos que no existen en el servidor: las fuentes se repiten en todo el curso -> un solo aviso
  const seenMissing = new Set<string>();
  let fontsWarned = false;
  for (const l of preLogs) log(l);
  for (const d of dedup.dropped) {
    warn(`Se ignora el elemento ${d.chapter}: usaría el mismo archivo (${chapterFileName(d.fileId)}) que ${d.keptChapter} y lo sobrescribiría.`);
  }
  if (!opts.retryFailed) {
    const nMods = new Set(urls.map((u) => chapterIdFromUrl(u).split('.')[0])).size;
    log(
      `Guardando ${urls.length} subcapítulos (${nMods} capítulos) como HTML` +
        (opts.resume ? ' (se omiten los ya verificados)' : ' (--force: se descarga todo)') +
        (lanes > 1 ? ` · ${lanes} en paralelo` : '')
    );
    log(`Carpeta de salida: ${siteDir}`);
    if (ownLogFile) log(`Registro detallado: ${join(siteDir, LOG_FILE)}`, 3);
  }

  const outcomes: Array<ChapterOutcome | undefined> = new Array(todo.length);
  const entries: Array<IndexEntry | undefined> = new Array(todo.length);
  const downloaded = new Map<string, boolean>();
  const assetReasons = new Map<string, string>();
  const chapterAttempts = Math.min(Math.max(opts.retries, 0), 2) + 1;
  const tag = (idx: number) => chapterIdFromUrl(todo[idx]);

  // ---- reanudación: se verifican en paralelo los capítulos ya guardados ----
  const queue: number[] = [];
  const wantVideos = opts.videos !== false;
  const wantAnimations = opts.animations !== false;
  if (opts.resume && !opts.retryFailed) {
    const checks = await mapPool(todo, 8, async (u) =>
      verifyChapterFile(join(chaptersDir, chapterFileName(chapterIdFromUrl(u))), siteDir)
    );
    for (let idx = 0; idx < todo.length; idx++) {
      const chapter = chapterIdFromUrl(todo[idx]);
      const c = checks[idx];
      const v = c.ok ? c.value : undefined;
      if (v && chapterUpToDate(v, wantVideos, wantAnimations)) {
        log(`${name(chapter)}: ya guardado y verificado (se omite)`, 3);
        outcomes[idx] = { chapter, url: todo[idx], status: 'omitido' };
        progress.chapter(chapter).done('skip');
        continue;
      }
      if (v && v.bytes > 0) {
        const why = !v.ok
          ? v.problems[0]
          : v.stylesOutdated
            ? 'estilos de componentes anidados sin aplicar (textos fuera de sus cajas)'
            : v.format >= 2 && v.videosPending > 0
            ? `${v.videosPending} vídeo(s) sin reproductor offline (se activarán y descargarán)`
            : wantAnimations && (v.animationsPending ?? 0) > 0
              ? `${v.animationsPending} animación(es) sin recursos locales (se grabarán)`
              : `formato antiguo (v${v.format}, faltan pestañas/fuentes)`;
        log(`${name(chapter)}: se vuelve a descargar (${why})`, 3);
      }
      queue.push(idx);
    }
  } else {
    for (let idx = 0; idx < todo.length; idx++) queue.push(idx);
  }

  // ---- pestañas de trabajo ----
  const makePage = opts.newPage ?? (() => page.browserContext().newPage());
  const workers: Worker[] = [{ id: 0, page, own: false, retired: false, done: 0, since: 0 }];
  const recycleEvery = Math.max(0, Math.floor(opts.recycleEvery ?? DEFAULT_RECYCLE_EVERY));
  const recycleHeapMb = opts.recycleHeapMb ?? DEFAULT_RECYCLE_HEAP_MB;
  let recycled = 0;
  const prepareWorkerPage = async (p: Page) => {
    await p.setViewport(VIEWPORT).catch(() => undefined);
    // que la pestaña se comporte como visible/enfocada aunque esté en segundo plano (rAF, temporizadores, carga diferida)
    await emulateFocus(p);
  };
  const replacePage = async (w: Worker, why: string) => {
    log(`Pestaña ${w.id + 1} del navegador: se reinicia (${why})`, 3);
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
    const label = name(chapter);
    const tStart = Date.now();
    const bar = progress.chapter(chapter);
    bar.start();

    let res: SaveChapterResult | null = null;
    let lastError = '';
    let fullRecapture = false;
    for (let attempt = 1; attempt <= chapterAttempts; attempt++) {
      try {
        if (attempt > 1) {
          const wait = backoffMs(attempt - 2, 1000, 8000);
          log(`${label}: reintento ${attempt - 1}/${chapterAttempts - 1} en ${Math.round(wait / 1000)}s (${lastError})`, 3);
          bar.stage(`reintento ${attempt - 1} en ${Math.round(wait / 1000)}s`);
          await delay(wait);
        }
        bar.stage('abriendo');
        const wp = w.page;
        res = await withTimeout(
          (async () => {
            await opts.prepareChapter(wp, chapterUrl);
            let r = await saveChapterHtml(wp, filePath, siteDir, downloaded, chapter, opts.assetOpts, assetReasons, {
              prescrolled: !!opts.prepareScrolls,
              videos: wantVideos,
              animations: wantAnimations,
              debugNetwork: opts.debugNetwork,
              animationMaxMs: opts.animationMaxMs,
              onStage: bar.stage,
            });
            // Carga sin terminar al guardar (loader/skeleton visible): recarga y re-captura UNA vez, con más paciencia.
            if (r.ok && r.incomplete && !fullRecapture) {
              fullRecapture = true;
              log(`${label}: carga sin terminar (${r.incomplete}); se recarga y se vuelve a capturar`, 3);
              await opts.prepareChapter(wp, chapterUrl);
              const r2 = await saveChapterHtml(wp, filePath, siteDir, downloaded, chapter, opts.assetOpts, assetReasons, {
                prescrolled: !!opts.prepareScrolls,
                videos: wantVideos,
                animations: wantAnimations,
                debugNetwork: opts.debugNetwork,
                animationMaxMs: opts.animationMaxMs,
                patient: true,
                onStage: (st) => bar.stage('2ª captura: ' + st),
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
            log(`Las pestañas extra del navegador no comparten la sesión (${lastError}); se continúa con una sola`, 3);
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
      const title = res.title && res.title !== chapter ? res.title : known.get(chapter);
      if (title) known.set(chapter, title);
      const label2 = name(chapter);
      const stats = `${res.assets} recursos, ${fmtMs(ms)}`;
      // detalle completo al registro (y en pantalla con -v 3)
      for (const wtxt of res.warnings) log(`${chapter} · aviso: ${wtxt}`, 3);
      for (const [rel, why] of failedAssets) log(`${chapter} · recurso fallido: ${rel} → ${why}`, 3);
      // recursos que no existen en el servidor: fuentes = un aviso para todo el curso; el resto, por subcapítulo
      const missing = res.missingOnServer ?? [];
      const fresh = missing.filter((u) => !seenMissing.has(u));
      for (const u of missing) seenMissing.add(u);
      for (const u of fresh) log(`${chapter} · no existe en el servidor: ${u}`, 3);
      const freshFonts = fresh.filter(isFontUrl);
      if (freshFonts.length && !fontsWarned) {
        fontsWarned = true;
        warn(`${freshFonts.length} recursos del curso no existen en el servidor (fuentes); se omiten en todos los subcapítulos.`);
      } else if (freshFonts.length) {
        warn(`${freshFonts.length} fuentes más no existen en el servidor; se omiten.`);
      }
      const others = missing.filter((u) => !isFontUrl(u)).length;
      const short = [
        ...(others ? [`${others} ${others === 1 ? 'recurso no existe' : 'recursos no existen'} en el servidor`] : []),
        ...shortWarnings(res.warnings),
      ];
      if (res.incomplete) {
        const reason = `captura posiblemente incompleta: ${res.incomplete}` + (failedAssets.length ? `; ${failedAssets.length} recursos fallidos` : '');
        warn(`${label2}: parcial, carga sin terminar${failedAssets.length ? `, ${failedAssets.length} recursos sin descargar` : ''}${short.length ? ', ' + short.join(', ') : ''}`);
        log(`${chapter} · parcial: ${reason}`, 3);
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
        bar.done('warn', { title, ms });
      } else if (failedAssets.length === 0) {
        if (short.length) warn(`${label2}: ${short.join(', ')}`);
        else ok(`${label2} (${stats})`, progress.live ? 3 : 2);
        outcomes[idx] = {
          chapter,
          url: chapterUrl,
          status: 'guardado',
          ...(res.warnings.length ? { reason: res.warnings.join(' | ') } : {}),
          assets: res.assets,
          assetsFailed: 0,
          ms,
        };
        bar.done(short.length ? 'warn' : 'ok', { title, ms });
      } else {
        const reason = `${failedAssets.length}/${res.assets} recursos no se descargaron: ${failedAssets[0][1]}`;
        warn(`${label2}: parcial, ${failedAssets.length} de ${res.assets} recursos sin descargar${short.length ? ', ' + short.join(', ') : ''}`);
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
        bar.done('warn', { title, ms });
      }
    } else {
      fail(`${label}: falló (${shortError(lastError)})`);
      log(`${chapter} · error completo: ${lastError}`, 3);
      outcomes[idx] = { chapter, url: chapterUrl, status: 'fallido', reason: lastError, ms };
      bar.done('fail', { ms });
    }
    w.done++;
    doneMs += ms;
    doneCount++;
    const left = queue.length - doneCount;
    if (left > 0 && doneCount >= 2 && !progress.live) {
      const wall = (Date.now() - t0) / doneCount;
      log(`Progreso ${doneCount}/${queue.length} · ETA ~${fmtDuration(wall * left)}`, 3);
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

  /**
   * Libera la memoria del renderer: pestaña propia -> about:blank, cerrar y abrir una nueva;
   * pestaña de la sesión -> solo about:blank (no se cierra: conserva la sesión).
   */
  const recycleTab = async (w: Worker, why: string) => {
    log(`Pestaña ${w.id + 1} del navegador: reciclada (${why})`, 3);
    w.since = 0;
    recycled++;
    const old = w.page;
    if (!w.own) {
      // Pestaña de la sesión: no se cierra. about:blank no libera el renderer (sigue en el mismo proceso);
      // ir a una página interna (chrome://version) obliga a Chrome a cambiar de proceso y soltar el anterior.
      await withTimeout(old.goto('chrome://version').catch(() => undefined), 15_000, 'al cambiar de proceso').catch(() => undefined);
    }
    await withTimeout(old.goto('about:blank').catch(() => undefined), 15_000, 'al vaciar la pestaña').catch(() => undefined);
    if (!w.own) return;
    await old.close().catch(() => undefined);
    try {
      w.page = await makePage();
      await prepareWorkerPage(w.page);
    } catch (e) {
      log(`Pestaña ${w.id + 1} del navegador: no se pudo reabrir (${e instanceof Error ? e.message : e}); se retira`, 3);
      w.retired = true;
    }
  };

  const maybeRecycle = async (w: Worker) => {
    if (w.retired || w.page.isClosed() || opts.signal?.aborted) return;
    if (nextQ >= queue.length && requeue.length === 0) return; // no quedan capítulos
    let why: string | null = null;
    if (recycleEvery > 0 && w.since >= recycleEvery) why = `cada ${recycleEvery} capítulos`;
    else why = await recycleReason(w.page, recycleHeapMb, opts.freeMemMb).catch(() => null);
    if (why) await recycleTab(w, why);
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
        w.since++;
        await maybeRecycle(w);
      } catch (e) {
        // nunca debe pasar (processChapter captura todo); por seguridad, no perder el capítulo
        const chapter = chapterIdFromUrl(todo[idx]);
        const msg = e instanceof Error ? e.message : String(e);
        fail(`${name(chapter)}: falló (error interno: ${shortError(msg)})`);
        outcomes[idx] = { chapter, url: todo[idx], status: 'fallido', reason: `error interno: ${msg}` };
        progress.chapter(chapter).done('fail');
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
        workers.push({ id: i, page: p, own: true, retired: false, done: 0, since: 0 });
      } catch (e) {
        log(`No se pudo abrir la pestaña ${i + 1} del navegador: ${e instanceof Error ? e.message : e}`, 3);
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
    warn('No hay subcapítulos guardados. No se actualiza index.html para no borrar el índice anterior.');
  } else {
    indexPath = join(siteDir, 'index.html');
    const tmp = `${indexPath}.part`;
    await writeFile(tmp, buildIndexHtml(courseTitle, indexEntries), 'utf8');
    await rename(tmp, indexPath);
  }

  // ---- resumen + lista de fallos reintentables ----
  const failures = mergeFailures(previous, processed.filter((o) => o.status !== 'omitido'));
  const files = await writeRunFiles(siteDir, info, processed, failures, startedAt, !!opts.partial || opts.retryFailed);
  const t = totalsOf(processed);
  if (opts.partial || opts.retryFailed) log('Ejecución parcial: el resumen y el índice se han mezclado con lo ya existente; el resto del curso no se ha tocado.', 1);
  const wallMs = Date.now() - t0;
  log('', 1);
  log('──────── Resumen ────────', 1);
  log(`Curso: ${courseTitle}`, 1);
  log(`Subcapítulos: ${t.total} · guardados ${t.guardado} · omitidos ${t.omitido} · parciales ${t.parcial} · fallidos ${t.fallido}`, 1, t.fallido ? 'error' : t.parcial ? 'warn' : 'ok');
  if (recycled > 0) log(`Pestañas recicladas: ${recycled} (liberan memoria del navegador)`, 1);
  log(`Duración: ${fmtDuration(wallMs)}` + (workers.length > 1 && sumWorkMs.v > 0 ? ` (${workers.length} en paralelo; ganancia ×${(sumWorkMs.v / Math.max(1, wallMs)).toFixed(1)})` : ''), 1);
  if (aborted) {
    warn(`Interrumpido: ${pending} subcapítulo(s) sin procesar. Vuelve a ejecutar el mismo comando para continuar (se omiten los ya guardados).`);
  }
  for (const o of processed.filter((x) => x.status === 'parcial' || x.status === 'fallido')) {
    const k = o.status === 'fallido' ? 'error' : 'warn';
    log(`${name(o.chapter)}: ${o.status} (${shortError(o.reason ?? '', 80)})`, 1, k);
  }
  if (failures.length) {
    warn(`Pendientes: ${failures.length} subcapítulo(s) en ${files.failuresPath}`);
    log(`Para reintentar solo esos: node lib/cli.js --retry-failed --user <usuario> "<url-del-curso>"`, 1);
  } else {
    ok(`Sin fallos pendientes. Resumen: ${files.summaryPath}`, 1);
  }
  if (ownLogFile) log(`Detalles (URLs, códigos de error): ${join(siteDir, LOG_FILE)}`, 1);
  if (indexPath) ok(`Abre: ${indexPath}`, 1);
  void SUMMARY_FILE;
  void doneMs;

  if (ownLogFile) setLogFile(null);
  return { siteDir, outcomes: processed, failures: failures.length, indexPath, aborted, pending };
}
