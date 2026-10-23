/**
 * Validación de subtemas (1.1.1, 1.1.2, ...) detectados en el texto de un capítulo.
 *
 * Problema real (curso OSPF): el texto de las páginas contiene direcciones IP y redes
 * ("10.1.0.0/16", "172.16.5.0/24", "2.2.2.2") que empiezan igual que un número de subtema
 * (`\d+.\d+.\d+`). Se tomaban por subtemas con título ".0/16", ".0/24" o ".2".
 * Un subtema válido es "número + título con texto" y el número NO continúa con ".dígito" ni "/".
 */

export type Subtopic = { sub: string; title: string };

/** Número de subtema plausible: tres grupos de 1-3 dígitos (nunca octetos de una IP larga). */
const SUB_NUMBER = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** Títulos imposibles: vacíos, que empiezan por "." o "/", o solo dígitos/puntuación (resto de una IP). */
export function isBogusSubtopicTitle(title: string): boolean {
  const t = title.trim();
  if (!t) return true;
  if (/^[./]/.test(t)) return true;
  if (/^\.\d+(\/\d+)?$/.test(t)) return true;
  if (!/\p{L}/u.test(t)) return true; // sin ninguna letra: "0/16", ".2", "255.255.0.0"
  return false;
}

/**
 * ¿Es un subtema real? `section` (p. ej. "1.3") es opcional: si se conoce, el subtema
 * debe pertenecer a ella (1.3.x); si no, solo se aplican las reglas de forma y título.
 */
export function isPlausibleSubtopic(s: Subtopic, section?: string): boolean {
  if (!SUB_NUMBER.test(s.sub)) return false;
  if (isBogusSubtopicTitle(s.title)) return false;
  if (section && /^\d+\.\d+$/.test(section) && !s.sub.startsWith(section + '.')) return false;
  return true;
}

export function filterPlausibleSubtopics(subs: Subtopic[], section?: string): Subtopic[] {
  return subs.filter((s) => isPlausibleSubtopic(s, section));
}

/**
 * Sección a la que pertenece un capítulo guardado.
 * `chapterId` puede ser "1.0", "2.3" o, por compatibilidad con el nombrado antiguo
 * (X.1 -> X), solo "1" (que es la sección 1.1).
 */
export function sectionOfChapter(chapterId: string): string | undefined {
  if (/^\d+\.\d+$/.test(chapterId)) return chapterId;
  if (/^\d+$/.test(chapterId)) return `${chapterId}.1`;
  return undefined;
}
