import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

export const SUMMARY_FILE = 'descarga-resumen.json';
export const FAILURES_FILE = 'descarga-fallos.json';

export type ChapterStatus = 'guardado' | 'omitido' | 'parcial' | 'fallido';

export type ChapterOutcome = {
  chapter: string;
  url: string;
  status: ChapterStatus;
  /** Motivo (fallido/parcial) o aviso. */
  reason?: string;
  assets?: number;
  assetsFailed?: number;
  failedAssets?: string[];
  attempts?: number;
  ms?: number;
};

export type FailureEntry = {
  chapter: string;
  url: string;
  reason: string;
  status: 'parcial' | 'fallido';
  failedAssets?: string[];
  at: string;
};

export type FailuresFile = {
  version: 1;
  courseId: string;
  courseTitle: string;
  courseUrl: string;
  updatedAt: string;
  failures: FailureEntry[];
};

export type SummaryFile = {
  version: 1;
  courseId: string;
  courseTitle: string;
  courseUrl: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  totals: Record<ChapterStatus | 'total', number>;
  chapters: ChapterOutcome[];
};

export function totalsOf(chapters: ChapterOutcome[]): SummaryFile['totals'] {
  const t = { total: chapters.length, guardado: 0, omitido: 0, parcial: 0, fallido: 0 };
  for (const c of chapters) t[c.status]++;
  return t;
}

export async function readFailures(siteDir: string): Promise<FailuresFile | null> {
  try {
    const j = JSON.parse(await readFile(join(siteDir, FAILURES_FILE), 'utf8'));
    if (j && Array.isArray(j.failures)) return j as FailuresFile;
  } catch {
    // no hay archivo o está corrupto
  }
  return null;
}

/**
 * Combina los fallos anteriores con el resultado de esta ejecución:
 * un capítulo que ahora salió bien deja de estar en la lista.
 */
export function mergeFailures(
  previous: FailureEntry[],
  attempted: ChapterOutcome[],
  now = new Date()
): FailureEntry[] {
  const attemptedIds = new Set(attempted.map((c) => c.chapter));
  const kept = previous.filter((f) => !attemptedIds.has(f.chapter));
  const fresh: FailureEntry[] = attempted
    .filter((c) => c.status === 'fallido' || c.status === 'parcial')
    .map((c) => ({
      chapter: c.chapter,
      url: c.url,
      reason: c.reason ?? 'error desconocido',
      status: c.status as 'parcial' | 'fallido',
      failedAssets: c.failedAssets?.slice(0, 50),
      at: now.toISOString(),
    }));
  return [...kept, ...fresh];
}

export async function writeRunFiles(
  siteDir: string,
  info: { courseId: string; courseTitle: string; courseUrl: string },
  chapters: ChapterOutcome[],
  failures: FailureEntry[],
  startedAt: Date
): Promise<{ summaryPath: string; failuresPath: string }> {
  const finished = new Date();
  await mkdir(siteDir, { recursive: true });
  const summary: SummaryFile = {
    version: 1,
    ...info,
    startedAt: startedAt.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: finished.getTime() - startedAt.getTime(),
    totals: totalsOf(chapters),
    chapters,
  };
  const failuresFile: FailuresFile = {
    version: 1,
    ...info,
    updatedAt: finished.toISOString(),
    failures,
  };
  const summaryPath = join(siteDir, SUMMARY_FILE);
  const failuresPath = join(siteDir, FAILURES_FILE);
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  await writeFile(failuresPath, JSON.stringify(failuresFile, null, 2), 'utf8');
  return { summaryPath, failuresPath };
}

/** Ruta del directorio padre; útil para tests. */
