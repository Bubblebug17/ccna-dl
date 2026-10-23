import { readFile } from 'fs/promises';
import { join, normalize } from 'path';

/**
 * Chrome bloquea los `<track src="archivo.vtt">` cuando la página se abre desde file:// (CORS), y el curso
 * se lee sin servidor. Por eso, tras descargar los subtítulos, se incrustan en el propio `<track>`
 * como `data:text/vtt;base64,...` (el .vtt descargado se conserva en assets/ por si se quiere aparte).
 */
export function vttToDataUri(vtt: string): string {
  const text = vtt.replace(/^\uFEFF/, '');
  return 'data:text/vtt;charset=utf-8;base64,' + Buffer.from(text, 'utf8').toString('base64');
}

const TRACK_RE = /<track\b[^>]*>/gi;
const SRC_RE = /\ssrc="(\.\.\/assets\/[^"]+\.(?:vtt|srt))"/i;

/** Devuelve el HTML con los <track> locales (.vtt) incrustados. */
export async function inlineLocalTracks(html: string, siteDir: string): Promise<{ html: string; inlined: number; missing: string[] }> {
  const jobs: Array<{ tag: string; rel: string }> = [];
  let m: RegExpExecArray | null;
  TRACK_RE.lastIndex = 0;
  while ((m = TRACK_RE.exec(html)) !== null) {
    const sm = m[0].match(SRC_RE);
    if (sm) jobs.push({ tag: m[0], rel: sm[1] });
  }
  if (!jobs.length) return { html, inlined: 0, missing: [] };

  const cache = new Map<string, string | null>();
  let out = html;
  let inlined = 0;
  const missing: string[] = [];
  for (const job of jobs) {
    let data = cache.get(job.rel);
    if (data === undefined) {
      try {
        let rel = job.rel.replace(/^\.\.\//, '');
        try {
          rel = decodeURIComponent(rel);
        } catch {
          // tal cual
        }
        const txt = await readFile(normalize(join(siteDir, rel)), 'utf8');
        data = /^\uFEFF?WEBVTT/.test(txt) ? vttToDataUri(txt) : null;
      } catch {
        data = null;
      }
      cache.set(job.rel, data);
    }
    if (!data) {
      missing.push(job.rel);
      continue;
    }
    const replaced = job.tag.replace(SRC_RE, ` src="${data}"`).replace(/\sdata-ccna-ext="[^"]*"/i, '');
    out = out.split(job.tag).join(replaced);
    inlined++;
  }
  return { html: out, inlined, missing };
}
