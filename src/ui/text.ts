/** Utilidades de texto para la terminal: ancho visible (sin códigos ANSI), recorte y ajuste de línea. */

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

export const stripAnsi = (s: string): string => s.replace(ANSI, '');
export const visLen = (s: string): number => [...stripAnsi(s)].length;

/** Ancho de la terminal (columnas) o Infinity si la salida no es una terminal. */
export function termWidth(): number {
  return process.stdout.isTTY ? Math.max(20, process.stdout.columns || 80) : Infinity;
}
export function termHeight(): number {
  return process.stdout.isTTY ? Math.max(6, process.stdout.rows || 24) : Infinity;
}

/** Recorta a `width` columnas visibles conservando los códigos de color; añade … si recorta. */
export function fitAnsi(s: string, width: number): string {
  if (!Number.isFinite(width) || visLen(s) <= width) return s;
  if (width <= 1) return '…';
  let out = '';
  let n = 0;
  let i = 0;
  while (i < s.length && n < width - 1) {
    if (s[i] === '\x1b') {
      const m = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(s.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    out += ch;
    i += ch.length;
    n++;
  }
  return out + '…' + (s.includes('\x1b[') ? '\x1b[0m' : '');
}

/** Recorta texto plano a `width` caracteres con … al final. */
export function fit(s: string, width: number): string {
  const a = [...s];
  if (a.length <= width) return s;
  return width <= 1 ? '…' : a.slice(0, width - 1).join('') + '…';
}

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
