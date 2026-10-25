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
  [/^(\d+) contenedor\(es\) de contenido vacío/, (m) => pl(+m[1], 'bloque de contenido vacío', 'bloques de contenido vacíos')],
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
