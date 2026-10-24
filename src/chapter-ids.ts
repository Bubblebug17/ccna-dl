/**
 * Identificadores de capítulo y colisiones.
 *
 * El archivo de un capítulo se llama por su id: X.Y -> "X.Y" salvo X.1 -> "X" (y X.Y.1 -> X.Y,
 * formato antiguo). Problema real (curso OSPF): el outline incluye elementos "2.2.1 Prueba de mi
 * conocimiento" (un cuestionario) que se aceptaban como capítulo "2.2.1", cuyo id de archivo
 * también es "2.2". Se guardaban DESPUÉS de la sección real 2.2 y la sobrescribían.
 */

export type WithChapter = { chapter: string };

/** Quita las entradas X.Y.1 cuando también existe X.Y (son sub-elementos de esa sección, no secciones). */
export function dropShadowedSubchapters<T extends WithChapter>(entries: T[]): { kept: T[]; dropped: T[] } {
  const have = new Set(entries.map((e) => e.chapter));
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const e of entries) {
    const m = e.chapter.match(/^(\d+\.\d+)\.1$/);
    if (m && have.has(m[1])) dropped.push(e);
    else kept.push(e);
  }
  return { kept, dropped };
}

/** Id de archivo a partir del `_chapter` (X.1 -> X, X.Y.1 -> X.Y). */
export function fileChapterId(chapter: string): string {
  return chapter.replace(/\.1$/, '');
}

/**
 * Garantiza un único URL por id de archivo. Si dos URLs comparten id, gana la que NO viene de
 * un X.Y.1 recortado (la sección real). Devuelve también lo descartado para avisar.
 */
export function dedupeByFileId(
  urls: string[],
  chapterOf: (url: string) => string
): { urls: string[]; dropped: Array<{ url: string; chapter: string; fileId: string; keptChapter: string }> } {
  const byId = new Map<string, number>();
  const out: string[] = [];
  const dropped: Array<{ url: string; chapter: string; fileId: string; keptChapter: string }> = [];
  for (const url of urls) {
    const chapter = chapterOf(url);
    const id = fileChapterId(chapter);
    const at = byId.get(id);
    if (at === undefined) {
      byId.set(id, out.length);
      out.push(url);
      continue;
    }
    const keptChapter = chapterOf(out[at]);
    // la entrada con id exacto (sin .1 recortado) tiene prioridad
    if (/^\d+\.\d+\.1$/.test(keptChapter) && !/^\d+\.\d+\.1$/.test(chapter)) {
      dropped.push({ url: out[at], chapter: keptChapter, fileId: id, keptChapter: chapter });
      out[at] = url;
    } else {
      dropped.push({ url, chapter, fileId: id, keptChapter });
    }
  }
  return { urls: out, dropped };
}
