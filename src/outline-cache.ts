/**
 * Caché del outline (<curso>/outline-cache.json): solo capítulo → view ID de datos ya obtenidos en una
 * ejecución anterior. Permite pedir `--only` sin volver a escanear el outline del curso.
 * No contiene credenciales ni cookies (los view ID son identificadores públicos de contenido del curso).
 */
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { join } from 'path';
import { matchesOnly, modulesOfOnly, explicitChaptersOfOnly, OnlySpec } from './only-spec';
import { urlToChapter } from './url-to-chapter-id';

export const OUTLINE_CACHE_FILE = 'outline-cache.json';
/** Pasados estos días la caché se ignora (por si el curso cambió). */
export const OUTLINE_CACHE_MAX_AGE_DAYS = 30;

export type OutlineCacheEntry = { chapter: string; viewId: string };
export type OutlineCache = {
  version: 1;
  courseId: string;
  savedAt: string;
  /** El outline completo se leyó en esta ejecución (todos los módulos). */
  complete: boolean;
  /** Módulos leídos enteros (aunque `complete` sea false). */
  modules: number[];
  entries: OutlineCacheEntry[];
};

function parseLaunchUrl(url: string): OutlineCacheEntry | null {
  try {
    const view = new URL(url).searchParams.get('view');
    if (!view) return null;
    return { chapter: urlToChapter(url), viewId: view };
  } catch {
    return null;
  }
}

export function entriesFromUrls(urls: string[]): OutlineCacheEntry[] {
  return urls.map(parseLaunchUrl).filter((e): e is OutlineCacheEntry => !!e);
}

export async function readOutlineCache(siteDir: string, courseId: string): Promise<OutlineCache | null> {
  try {
    const j = JSON.parse(await readFile(join(siteDir, OUTLINE_CACHE_FILE), 'utf8'));
    if (j && j.version === 1 && j.courseId === courseId && Array.isArray(j.entries) && typeof j.savedAt === 'string') {
      return {
        version: 1,
        courseId,
        savedAt: j.savedAt,
        complete: !!j.complete,
        modules: Array.isArray(j.modules) ? j.modules.map(Number).filter((n: number) => Number.isFinite(n)) : [],
        entries: j.entries.filter(
          (e: OutlineCacheEntry) => e && typeof e.chapter === 'string' && /^[0-9a-f-]{36}$/i.test(String(e.viewId))
        ),
      };
    }
  } catch {
    // no hay caché o está corrupta: se ignora
  }
  return null;
}

/**
 * Combina lo ya guardado con lo obtenido ahora (solo se actualizan los capítulos vistos).
 * `fullScan`: se escaneó todo el outline -> la caché pasa a ser completa y se reemplaza.
 */
export function mergeOutlineCache(
  prev: OutlineCache | null,
  courseId: string,
  found: OutlineCacheEntry[],
  opts: { fullScan: boolean; wholeModules: number[]; now?: Date }
): OutlineCache {
  const now = (opts.now ?? new Date()).toISOString();
  if (opts.fullScan || !prev) {
    const mods = opts.fullScan ? [...new Set(found.map((e) => Number(e.chapter.split('.')[0])))] : opts.wholeModules;
    return { version: 1, courseId, savedAt: now, complete: opts.fullScan, modules: mods.sort((a, b) => a - b), entries: sortEntries(found) };
  }
  const byChapter = new Map(prev.entries.map((e) => [e.chapter, e] as const));
  // los módulos leídos enteros ahora sustituyen lo anterior de ese módulo
  const whole = new Set(opts.wholeModules);
  for (const [ch] of [...byChapter]) if (whole.has(Number(ch.split('.')[0]))) byChapter.delete(ch);
  for (const e of found) byChapter.set(e.chapter, e);
  return {
    version: 1,
    courseId,
    savedAt: now,
    complete: prev.complete,
    modules: [...new Set([...prev.modules, ...opts.wholeModules])].sort((a, b) => a - b),
    entries: sortEntries([...byChapter.values()]),
  };
}

function sortEntries(list: OutlineCacheEntry[]): OutlineCacheEntry[] {
  const key = (c: string) => c.split('.').map(Number);
  return [...list].sort((a, b) => {
    const pa = key(a.chapter);
    const pb = key(b.chapter);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] ?? 0) - (pb[i] ?? 0);
      if (d) return d;
    }
    return 0;
  });
}

export async function writeOutlineCache(siteDir: string, cache: OutlineCache): Promise<void> {
  await mkdir(siteDir, { recursive: true });
  const file = join(siteDir, OUTLINE_CACHE_FILE);
  const tmp = `${file}.part`;
  await writeFile(tmp, JSON.stringify(cache, null, 2), 'utf8');
  await rename(tmp, file);
}

export function cacheAgeDays(cache: OutlineCache, now = new Date()): number {
  return (now.getTime() - new Date(cache.savedAt).getTime()) / 86_400_000;
}

/**
 * ¿Puede la caché contestar esta petición sin escanear? Sí si es reciente y: cada módulo pedido está
 * leído entero (o la caché es completa), y cada capítulo explícito está en la caché.
 * Devuelve los capítulos pedidos (ordenados) o null si hay que escanear.
 */
export function chaptersFromCache(cache: OutlineCache | null, spec: OnlySpec, now = new Date()): OutlineCacheEntry[] | null {
  if (!cache || cache.entries.length === 0) return null;
  const age = cacheAgeDays(cache, now);
  if (!(age >= -1 && age <= OUTLINE_CACHE_MAX_AGE_DAYS)) return null;

  const explicit = explicitChaptersOfOnly(spec);
  const known = new Set(cache.entries.map((e) => e.chapter));
  for (const c of explicit) if (!known.has(c)) return null;

  for (const mod of modulesOfOnly(spec)) {
    // un módulo pedido solo por ids explícitos (2.3) no necesita estar leído entero
    const wholeNeeded = spec.terms.some(
      (t) =>
        t.kind === 'module' ? t.module === mod :
        t.kind === 'moduleRange' ? mod >= t.from && mod <= t.to :
        t.kind === 'range' ? mod >= t.from[0] && mod <= t.to[0] : false
    );
    if (wholeNeeded && !cache.complete && !cache.modules.includes(mod)) return null;
  }

  const picked = cache.entries.filter((e) => matchesOnly(spec, e.chapter));
  return picked.length ? sortEntries(picked) : null;
}
