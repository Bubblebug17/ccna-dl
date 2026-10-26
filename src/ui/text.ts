/** Utilidades de texto para la terminal: ancho visible (sin códigos ANSI), recorte y ajuste de línea. */

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

export const stripAnsi = (s: string): string => s.replace(ANSI, '');

// Emoji que la terminal pinta a 2 columnas aunque estén en el plano básico (presentación emoji por defecto).
const EMOJI_BMP = new Set([
  0x231a, 0x231b, 0x23e9, 0x23ea, 0x23eb, 0x23ec, 0x23f0, 0x23f3, 0x25fd, 0x25fe, 0x2614, 0x2615, 0x267f, 0x2693, 0x26a1,
  0x26aa, 0x26ab, 0x26bd, 0x26be, 0x26c4, 0x26c5, 0x26ce, 0x26d4, 0x26ea, 0x26f2, 0x26f3, 0x26f5, 0x26fa, 0x26fd, 0x2705,
  0x270a, 0x270b, 0x2728, 0x274c, 0x274e, 0x2753, 0x2754, 0x2755, 0x2757, 0x2795, 0x2796, 0x2797, 0x27b0, 0x27bf, 0x2b1b,
  0x2b1c, 0x2b50, 0x2b55,
]);

/** Columnas que ocupa un carácter (code point): 0 combinantes/de control, 2 anchos (CJK, emoji), 1 el resto. */
export function charWidth(cp: number): number {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0x2060 || cp === 0xfeff) return 0;
  if (cp >= 0xfe00 && cp <= 0xfe0f) return 0; // selectores de variación (se tratan en strWidth)
  if (cp >= 0x1f3fb && cp <= 0x1f3ff) return 0; // tono de piel
  const ch = String.fromCodePoint(cp);
  if (/\p{Mn}|\p{Me}/u.test(ch)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f000 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd) ||
    EMOJI_BMP.has(cp)
  )
    return 2;
  return 1;
}

/** Ancho visible en columnas de la terminal (sin ANSI; emoji y CJK = 2; combinantes = 0; X+U+FE0F = 2). */
export function strWidth(s: string): number {
  const cps = [...stripAnsi(s)].map((x) => x.codePointAt(0)!);
  let w = 0;
  for (let i = 0; i < cps.length; i++) {
    let cw = charWidth(cps[i]);
    if (cw === 1 && cps[i + 1] === 0xfe0f) cw = 2; // ⚠️ con selector de emoji
    if (i > 0 && cps[i - 1] === 0x200d) cw = 0; // secuencias ZWJ: una sola figura
    w += cw;
  }
  return w;
}
export const visLen = strWidth;

/** Quita saltos de línea, tabuladores y otros controles (no los códigos de color). */
export const oneLine = (s: string): string => s.replace(/[\r\n\t\v\f]+/g, ' ').replace(/[\x00-\x08\x0e-\x1a\x1c-\x1f\x7f]/g, '');

/** Ancho de la terminal (columnas) o Infinity si la salida no es una terminal. */
export function termWidth(): number {
  return process.stdout.isTTY ? Math.max(20, process.stdout.columns || 80) : Infinity;
}
export function termHeight(): number {
  return process.stdout.isTTY ? Math.max(6, process.stdout.rows || 24) : Infinity;
}

/** Recorta a `width` columnas visibles conservando los códigos de color; añade … si recorta. */
export function fitAnsi(s: string, width: number): string {
  s = oneLine(s);
  if (!Number.isFinite(width) || strWidth(s) <= width) return s;
  if (width <= 1) return '…';
  let out = '';
  let n = 0;
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\x1b') {
      const m = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(s.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    const cw = charWidth(ch.codePointAt(0)!) + (s.codePointAt(i + ch.length) === 0xfe0f && charWidth(ch.codePointAt(0)!) === 1 ? 1 : 0);
    if (n + cw > width - 1) break;
    out += ch;
    i += ch.length;
    n += cw;
  }
  return out + '…' + (s.includes('\x1b[') ? '\x1b[0m' : '');
}

/** Recorta texto plano a `width` caracteres con … al final. */
export function fit(s: string, width: number): string {
  s = oneLine(s);
  if (strWidth(s) <= width) return s;
  if (width <= 1) return '…';
  let out = '';
  let n = 0;
  const a = [...s];
  for (let k = 0; k < a.length; k++) {
    const ch = a[k];
    const cw0 = charWidth(ch.codePointAt(0)!);
    const cw = cw0 === 1 && a[k + 1] === '\ufe0f' ? 2 : cw0;
    if (n + cw > width - 1) break;
    out += ch;
    n += cw;
  }
  return out + '…';
}

/** `s` (texto plano) rellenado con espacios hasta `width` columnas visibles. */
export const padW = (s: string, width: number): string => s + ' '.repeat(Math.max(0, width - strWidth(s)));

/** Filas físicas que ocupa una línea de `w` columnas en una terminal de `cols` columnas. */
export const physRows = (w: number, cols: number): number => Math.max(1, Math.ceil(w / Math.max(1, cols)));

/**
 * Ajusta texto plano a `width` columnas cortando por espacios; las líneas siguientes llevan `indent`.
 * Palabras más largas que la línea (rutas, URLs) se parten.
 */
export function wrap(text: string, width: number, indent: number): string[] {
  if (!Number.isFinite(width) || [...text].length <= width) return [text];
  const pad = ' '.repeat(indent);
  const lines: string[] = [];
  let cur = '';
  const room = () => width - (lines.length ? indent : 0);
  for (const word of text.split(/(\s+)/)) {
    if (!word) continue;
    if ([...cur + word].length <= room()) {
      cur += word;
      continue;
    }
    if (cur.trim()) {
      lines.push(cur.trimEnd());
      cur = '';
    }
    let w = word.trimStart();
    while ([...w].length > room()) {
      lines.push([...w].slice(0, room()).join(''));
      w = [...w].slice(room()).join('');
    }
    cur = w;
  }
  if (cur.trim()) lines.push(cur.trimEnd());
  return lines.map((l, i) => (i ? pad + l : l));
}
