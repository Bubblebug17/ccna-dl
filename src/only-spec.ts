/**
 * Expresión de --only: qué capítulos descargar sin sincronizar todo el curso.
 *
 *   2          todo el módulo 2 (2.0, 2.1, 2.2… lo que exista)
 *   2.3        un capítulo
 *   2.1,2.3,5  varios (capítulos y/o módulos)
 *   2.1-2.4    rango de capítulos (inclusive; también entre módulos: 2.5-3.2)
 *   2-4        rango de módulos
 *
 * Compatibilidad: un id exacto ("1.0", "12.1", "2.2.1") sigue seleccionando solo ese capítulo.
 */

export type OnlyTerm =
  | { kind: 'module'; module: number }
  | { kind: 'chapter'; id: string }
  | { kind: 'range'; from: [number, number]; to: [number, number] }
  | { kind: 'moduleRange'; from: number; to: number };

export type OnlySpec = { terms: OnlyTerm[]; text: string };

const CHAPTER_RE = /^(\d+)\.(\d+)(?:\.(\d+))?$/;
const MODULE_RE = /^\d+$/;

function chapterParts(id: string): [number, number] | null {
  const m = CHAPTER_RE.exec(id);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function cmpPair(a: [number, number], b: [number, number]): number {
  return a[0] - b[0] || a[1] - b[1];
}

/** Interpreta la expresión; lanza Error con un mensaje claro (en español) si no es válida. */
export function parseOnly(input: string): OnlySpec {
  const text = String(input ?? '').trim();
  const terms: OnlyTerm[] = [];
  const seen = new Set<string>();
  const push = (t: OnlyTerm) => {
    const key = JSON.stringify(t);
    if (seen.has(key)) return;
    seen.add(key);
    terms.push(t);
  };

  for (const raw of text.split(',')) {
    const tok = raw.trim();
    if (!tok) continue;
    const bad = () =>
      new Error(
        `--only: "${tok}" no es válido. Usa un capítulo (2.3), un módulo (2), una lista (2.1,2.3,5) o un rango (2.1-2.4).`
      );

    if (tok.includes('-')) {
      const parts = tok.split('-').map((s) => s.trim());
      if (parts.length !== 2 || !parts[0] || !parts[1]) throw bad();
      const [a, b] = parts;
      if (MODULE_RE.test(a) && MODULE_RE.test(b)) {
        const from = Number(a);
        const to = Number(b);
        if (from > to) throw new Error(`--only: el rango "${tok}" está al revés (el inicio es mayor que el final).`);
        push({ kind: 'moduleRange', from, to });
        continue;
      }
      const pa = chapterParts(a);
      const pb = chapterParts(b);
      if (!pa || !pb) throw bad();
      if (cmpPair(pa, pb) > 0) throw new Error(`--only: el rango "${tok}" está al revés (el inicio es mayor que el final).`);
      push({ kind: 'range', from: pa, to: pb });
      continue;
    }

    if (MODULE_RE.test(tok)) {
      push({ kind: 'module', module: Number(tok) });
      continue;
    }
    if (CHAPTER_RE.test(tok)) {
      push({ kind: 'chapter', id: tok });
      continue;
    }
    throw bad();
  }

  if (terms.length === 0) throw new Error('--only: la expresión está vacía.');
  return { terms, text };
}

/** ¿El capítulo del outline ("2.3", "2.2.1") está pedido? */
export function matchesOnly(spec: OnlySpec, chapter: string): boolean {
  const p = chapterParts(chapter);
  if (!p) return false;
  return spec.terms.some((t) => {
    switch (t.kind) {
      case 'module':
        return p[0] === t.module;
      case 'moduleRange':
        return p[0] >= t.from && p[0] <= t.to;
      case 'chapter':
        return t.id === chapter;
      case 'range':
        return cmpPair(p, t.from) >= 0 && cmpPair(p, t.to) <= 0;
    }
  });
}

/** Módulos que hay que expandir/leer en el outline (solo estos; no el resto del curso). */
export function modulesOfOnly(spec: OnlySpec): number[] {
  const mods = new Set<number>();
  for (const t of spec.terms) {
    if (t.kind === 'module') mods.add(t.module);
    else if (t.kind === 'chapter') mods.add(Number(t.id.split('.')[0]));
    else if (t.kind === 'range') for (let m = t.from[0]; m <= t.to[0]; m++) mods.add(m);
    else for (let m = t.from; m <= t.to; m++) mods.add(m);
  }
  return [...mods].sort((a, b) => a - b);
}

/** Ids pedidos de forma explícita (si no existen en el outline se avisa; los módulos/rangos no avisan). */
export function explicitChaptersOfOnly(spec: OnlySpec): string[] {
  return spec.terms.filter((t): t is Extract<OnlyTerm, { kind: 'chapter' }> => t.kind === 'chapter').map((t) => t.id);
}

/** Módulos pedidos ENTEROS (el outline de esos módulos se considera completo tras leerlos). */
export function wholeModulesOfOnly(spec: OnlySpec): number[] {
  const mods = new Set<number>();
  for (const t of spec.terms) {
    if (t.kind === 'module') mods.add(t.module);
    else if (t.kind === 'moduleRange') for (let m = t.from; m <= t.to; m++) mods.add(m);
  }
  return [...mods].sort((a, b) => a - b);
}

/** Descripción corta para los registros. */
export function describeOnly(spec: OnlySpec): string {
  return spec.terms
    .map((t) => {
      switch (t.kind) {
        case 'module':
          return `módulo ${t.module}`;
        case 'moduleRange':
          return `módulos ${t.from}-${t.to}`;
        case 'chapter':
          return `capítulo ${t.id}`;
        case 'range':
          return `capítulos ${t.from.join('.')}-${t.to.join('.')}`;
      }
    })
    .join(', ');
}
