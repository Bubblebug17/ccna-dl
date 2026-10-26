import { oneLine } from './text';

const MOD_PREFIX = /^(?:m[óo]dulo|module|cap[íi]tulo|chapter)\s*\d+\s*[:.\-–—]\s*/i;

/** Normaliza espacios/saltos de línea de un título de Netacad. */
// Caracteres invisibles de formato (U+206A "⁪REST", zero-width, BOM, guion suave…)
const INVISIBLE = /[\p{Cf}\u00ad\u034f\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/gu;
export const stripInvisible = (s: string) => s.replace(INVISIBLE, '');
const norm = (s: string) => stripInvisible(oneLine(s)).replace(/\s+/g, ' ').trim();

/**
 * Título corto de un subcapítulo: "Módulo 3: Conceptos… | 3.1. Estado Actual…" → "Estado Actual…".
 * Quita el prefijo del módulo y el número repetido ("3.1. ", "3.1 ").
 */
export function cleanTitle(id: string, raw: string | undefined): string {
  if (!raw) return '';
  // página propia del capítulo ("9"): su título de Netacad puede ser el de la primera sección (9.1); se usa el del módulo
  if (!id.includes('.')) {
    const mod = moduleTitleFrom(raw);
    if (mod) return mod;
  }
  let t = norm(raw);
  const parts = t.split(/\s+\|\s+/).filter(Boolean);
  if (parts.length > 1) t = parts[parts.length - 1];
  const esc = id.replace(/\./g, '\\.');
  t = t.replace(new RegExp(`^${esc}\\.?(?=\\s)\\s*[:.\\-–—]?\\s*`), '');
  t = t.replace(MOD_PREFIX, '');
  return t.trim();
}

/** Nombre del capítulo (módulo) a partir del título de cualquiera de sus páginas: "Módulo 3: Conceptos… | …" → "Conceptos…". */
export function moduleTitleFrom(raw: string | undefined): string {
  if (!raw) return '';
  const first = norm(raw).split(/\s+\|\s+/)[0];
  return MOD_PREFIX.test(first) ? first.replace(MOD_PREFIX, '').trim() : '';
}
