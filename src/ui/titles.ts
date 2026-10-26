import { oneLine } from './text';

const MOD_PREFIX = /^(?:m[óo]dulo|module|cap[íi]tulo|chapter)\s*\d+\s*[:.\-–—]\s*/i;

/** Normaliza espacios/saltos de línea de un título de Netacad. */
const norm = (s: string) => oneLine(s).replace(/\s+/g, ' ').trim();

/**
 * Título corto de un subcapítulo: "Módulo 3: Conceptos… | 3.1. Estado Actual…" → "Estado Actual…".
 * Quita el prefijo del módulo y el número repetido ("3.1. ", "3.1 ").
 */
export function cleanTitle(id: string, raw: string | undefined): string {
  if (!raw) return '';
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
