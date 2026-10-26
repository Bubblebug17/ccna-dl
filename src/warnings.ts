/**
 * Avisos de un subcapítulo en forma CORTA para la terminal ("1 vídeo sin reproductor offline").
 * El texto completo (URLs, códigos, notas) se guarda en ccna-dl.log y se ve con -v 3.
 */
const pl = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const RULES: Array<[RegExp, (m: RegExpMatchArray) => string | null]> = [
  [/^\d+ recurso\(s\) no existen en el servidor/, () => null], // se trata aparte (missingOnServer)
  [/^(\d+)(?: de \d+)? vídeo\(s\) sin reproductor offline/, (m) => pl(+m[1], 'vídeo sin reproductor offline', 'vídeos sin reproductor offline')],
  [/^(\d+)(?: de \d+)? animación\(es\) sin recursos locales/, (m) => pl(+m[1], 'animación sin grabar', 'animaciones sin grabar')],
  [/^recapturado una vez; sigue/, () => 'carga sin terminar tras recapturar'],
  [/^recapturado una vez/, () => 'recapturado una vez'],
  // Contenedores vacíos con el contenido ya verificado: casi siempre decorativos (separadores, huecos de
  // widgets sin usar). Es una pista débil -> solo en ccna-dl.log y con -v 3, no en pantalla.
  [/^(\d+) contenedor\(es\) de contenido vacío/, () => null],
  [/^(\d+) subtítulo\(s\)/, (m) => pl(+m[1], 'subtítulo sin incrustar', 'subtítulos sin incrustar')],
  [/^(\d+) pestaña\(s\) no se pudieron capturar/, (m) => pl(+m[1], 'pestaña sin capturar', 'pestañas sin capturar')],
  [/^pestañas sin panel guardado/, () => 'pestañas sin panel guardado'],
  [/cargador de estilos antiguo/, () => 'estilos antiguos (hay que volver a descargarlo)'],
  [/^(\d+) recurso\(s\) siguen apuntando a internet/, (m) => pl(+m[1], 'recurso enlazado a internet', 'recursos enlazados a internet')],
  [/^sin <!DOCTYPE html>/, () => 'sin <!DOCTYPE html>'],
];

export function shortWarning(w: string): string | null {
  for (const [re, f] of RULES) {
    const m = w.match(re);
    if (m) return f(m);
  }
  // genérico: hasta el primer ":" o "(" y como mucho 60 caracteres
  const head = w.split(/[:(]/)[0].trim();
  return head.length > 60 ? head.slice(0, 59) + '…' : head;
}

/** Avisos cortos, sin repetir. */
export function shortWarnings(ws: string[]): string[] {
  return [...new Set(ws.map(shortWarning).filter((x): x is string => !!x))];
}

/** Fuentes del curso (ciscoSansTT…): faltan en el servidor en TODOS los capítulos, se avisa una sola vez. */
export const isFontUrl = (u: string) => /\/fonts?\/|\.(woff2?|ttf|otf|eot)(\?|#|$)/i.test(u);

/** Primera frase de un error, corta, para la terminal. */
export function shortError(e: string, max = 100): string {
  const first = e.split(/;\s|\n/)[0].trim();
  return first.length > max ? first.slice(0, max - 1) + '…' : first;
}

const isVideoRel = (rel: string) => /(^|\/)assets\/video\//.test(rel) || /\.(mp4|webm|m4v|mov)$/i.test(rel);

function causeOf(whys: string[]): string {
  const all = whys.join(' | ');
  if (/acceso denegado|HTTP (401|403)\b|40[13] (Forbidden|Unauthorized)/i.test(all)) return '403, la sesión expiró';
  if (/timeout/i.test(all)) return 'tiempo de espera agotado';
  if (/ffmpeg no está instalado/i.test(all)) return 'falta ffmpeg';
  if (/DRM/i.test(all)) return 'protegido con DRM';
  const http = all.match(/HTTP (\d{3})/);
  if (http) return `HTTP ${http[1]}`;
  return 'error de red';
}

/**
 * Una sola línea corta con los recursos que faltan de un subcapítulo:
 * "2 vídeos sin descargar (403, la sesión expiró); se reintentarán con --retry-failed".
 * Sin URLs ni salida de ffmpeg (eso va a ccna-dl.log / -v 3).
 */
export function failedSummary(failedAssets: Record<string, string>): string {
  const ents = Object.entries(failedAssets);
  const vids = ents.filter(([rel]) => isVideoRel(rel));
  const rest = ents.filter(([rel]) => !isVideoRel(rel));
  const parts: string[] = [];
  if (vids.length) parts.push(`${pl(vids.length, 'vídeo', 'vídeos')} sin descargar (${causeOf(vids.map(([, w]) => w))})`);
  if (rest.length) parts.push(`${pl(rest.length, 'recurso', 'recursos')} sin descargar (${causeOf(rest.map(([, w]) => w))})`);
  return parts.join(', ') + '; se reintentarán con --retry-failed';
}

/** Motivo sin la URL entre paréntesis (las URLs firmadas no van a pantalla ni al resumen). */
export const stripUrl = (why: string) => why.replace(/\s*\((?:https?:|blob:)[^)]*\)?\s*$/i, '').trim();
