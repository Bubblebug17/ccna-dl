import type { Page } from 'puppeteer';
import { mkdir, writeFile } from 'fs/promises';
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
import { backoffMs, fmtDuration } from './util/retry';
import { delay } from './util/promise';

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
};

export type SaveCourseResult = {
  siteDir: string;
  outcomes: ChapterOutcome[];
  failures: number;
  indexPath?: string;
};

export function chapterIdFromUrl(url: string): string {
  return urlToChapterId(url).replace(/\.1$/, '');
}

/** Guarda los capítulos de un curso "launch" como HTML offline. */
export async function saveLaunchCourseSite(
  page: Page,
  urls: string[],
  courseId: string,
  courseTitle: string,
  outDir: string,
  opts: SaveCourseOptions
): Promise<SaveCourseResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const startedAt = new Date();
  const t0 = Date.now();

  const folderName = sanitize(`${courseId}_${courseTitle}`) || courseId;
  const siteDir = join(outDir, folderName);
  const chaptersDir = join(siteDir, 'chapters');
  await mkdir(chaptersDir, { recursive: true });
  await page.setViewport({ width: 1400, height: 1200 });

  const info = { courseId, courseTitle, courseUrl: opts.courseUrl };
  const previous = (await readFailures(siteDir))?.failures ?? [];

  // --retry-failed: solo los capítulos anotados como fallidos/parciales
  let todo = urls;
  if (opts.retryFailed) {
    const wanted = new Set(previous.map((f) => f.chapter));
    todo = urls.filter((u) => wanted.has(chapterIdFromUrl(u)));
    if (previous.length === 0) {
      log(`No hay ${FAILURES_FILE} con capítulos pendientes en ${siteDir}. Nada que reintentar.`);
    } else {
      log(`Reintentando ${todo.length} capítulo(s) fallido(s) de ${previous.length} anotados.`);
      const missing = previous.filter((f) => !todo.some((u) => chapterIdFromUrl(u) === f.chapter));
      if (missing.length) {
        log(`  · ${missing.length} no aparecen ahora en el outline: ${missing.map((m) => m.chapter).join(', ')}`);
      }
    }
  } else {
    log(`Guardando ${urls.length} capítulos como HTML en ${siteDir}` + (opts.resume ? ' (se omiten los ya verificados)' : ' (--force: se descarga todo)'));
  }

  const entries: IndexEntry[] = [];
  const outcomes: ChapterOutcome[] = [];
  const downloaded = new Map<string, boolean>();
  const assetReasons = new Map<string, string>();
  const chapterAttempts = Math.min(Math.max(opts.retries, 0), 2) + 1;
  let doneMs = 0;
  let doneCount = 0;

  for (let idx = 0; idx < todo.length; idx++) {
    const chapterUrl = todo[idx];
    const chapter = chapterIdFromUrl(chapterUrl);
    const fileName = chapterFileName(chapter);
    const filePath = join(chaptersDir, fileName);
    const tag = `[${idx + 1}/${todo.length}] ${chapter}`;
    const tStart = Date.now();

    // ---- reanudación: capítulo ya guardado y verificado ----
    if (opts.resume && !opts.retryFailed) {
      const v = await verifyChapterFile(filePath, siteDir);
      if (v.ok && v.format >= CHAPTER_FORMAT) {
        log(`${tag} · omitido (ya guardado y verificado)`);
        outcomes.push({ chapter, url: chapterUrl, status: 'omitido' });
        continue;
      }
      if (v.bytes > 0) {
        const why = !v.ok ? v.problems[0] : `formato antiguo (v${v.format}, faltan pestañas/fuentes)`;
        log(`${tag} · se vuelve a descargar: ${why}`);
      }
    }

    let res: SaveChapterResult | null = null;
    let lastError = '';
    for (let attempt = 1; attempt <= chapterAttempts; attempt++) {
      try {
        if (attempt > 1) {
          const wait = backoffMs(attempt - 2, 1000, 8000);
          log(`${tag} · reintento ${attempt - 1}/${chapterAttempts - 1} en ${Math.round(wait / 1000)}s (${lastError})`);
          await delay(wait);
        }
        await opts.prepareChapter(page, chapterUrl);
        res = await saveChapterHtml(page, filePath, siteDir, downloaded, chapter, opts.assetOpts, assetReasons);
        if (res.ok) break;
        lastError = res.problems.join('; ') || 'sin contenido';
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        res = null;
      }
    }

    const ms = Date.now() - tStart;
    if (res && res.ok) {
      entries.push({
        chapter,
        title: res.title || chapter,
        file: `chapters/${fileName}`,
        subtopics: res.subtopics,
      });
      const failedAssets = Object.entries(res.failedAssets);
      const tabsInfo = res.tabs.widgets ? `, pestañas ${res.tabs.captured}/${res.tabs.tabs}` : '';
      if (failedAssets.length === 0 && res.warnings.length === 0) {
        log(`${tag} · ✔ guardado (${res.assets} recursos${tabsInfo}, ${fmtDuration(ms)})`);
        outcomes.push({ chapter, url: chapterUrl, status: 'guardado', assets: res.assets, assetsFailed: 0, ms });
      } else if (failedAssets.length === 0) {
        log(`${tag} · ✔ guardado con avisos (${res.assets} recursos${tabsInfo}): ${res.warnings.join(' | ')}`);
        outcomes.push({ chapter, url: chapterUrl, status: 'guardado', reason: res.warnings.join(' | '), assets: res.assets, assetsFailed: 0, ms });
      } else {
        const reason = `${failedAssets.length}/${res.assets} recursos no se descargaron: ${failedAssets[0][1]}`;
        log(`${tag} · ⚠ parcial: ${reason}`);
        outcomes.push({
          chapter,
          url: chapterUrl,
          status: 'parcial',
          reason,
          assets: res.assets,
          assetsFailed: failedAssets.length,
          failedAssets: failedAssets.map(([rel, why]) => `${rel} → ${why}`),
          ms,
        });
      }
    } else {
      log(`${tag} · ✖ fallido: ${lastError}`);
      outcomes.push({ chapter, url: chapterUrl, status: 'fallido', reason: lastError, ms });
    }

    doneMs += Date.now() - tStart;
    doneCount++;
    const left = todo.length - idx - 1;
    if (left > 0 && doneCount >= 2) {
      log(`    progreso ${idx + 1}/${todo.length} · ETA ~${fmtDuration((doneMs / doneCount) * left)}`);
    }
  }

  // ---- índice: capítulos nuevos + los que ya estaban en disco ----
  let indexPath: string | undefined;
  const fromDisk = await entriesFromSavedChapters(chaptersDir);
  const indexEntries = mergeIndexEntries(fromDisk, entries);
  if (indexEntries.length === 0) {
    log('No hay capítulos guardados. No se actualiza index.html para no borrar el índice anterior.');
  } else {
    indexPath = join(siteDir, 'index.html');
    await writeFile(indexPath, buildIndexHtml(courseTitle, indexEntries), 'utf8');
  }

  // ---- resumen + lista de fallos reintentables ----
  const failures = mergeFailures(previous, outcomes.filter((o) => o.status !== 'omitido'));
  const files = await writeRunFiles(siteDir, info, outcomes, failures, startedAt);
  const t = totalsOf(outcomes);
  log('');
  log('════════ Resumen ════════');
  log(`Curso: ${courseTitle}`);
  log(`Capítulos: ${t.total} · guardados ${t.guardado} · omitidos ${t.omitido} · parciales ${t.parcial} · fallidos ${t.fallido}`);
  log(`Duración: ${fmtDuration(Date.now() - t0)}`);
  for (const o of outcomes.filter((x) => x.status === 'parcial' || x.status === 'fallido')) {
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

  return { siteDir, outcomes, failures: failures.length, indexPath };
}
