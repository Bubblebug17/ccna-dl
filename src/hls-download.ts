import type { Frame, Page } from 'puppeteer';
import { spawn } from 'child_process';
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { ffmpegBin } from './platform';
import { FfmpegMissingError, ffmpegDownload } from './ffmpeg-download';
import { mapPool } from './util/retry';
import { sessionHeadersFor, streamSniff } from './stream-auth';

/**
 * Descarga de vídeos HLS con la sesión del navegador.
 *
 * En vez de darle la URL remota a ffmpeg (que pide el m3u8 y los segmentos con sus propias cabeceras y
 * falla con 403 si la CDN exige cookies firmadas, Referer/Origin o UA del reproductor), se baja el
 * manifiesto, la variante, las claves (EXT-X-KEY), el init (EXT-X-MAP) y los segmentos con:
 *   1) fetch de Node con las cookies FRESCAS de esa URL + UA real + Referer/Origin del reproductor;
 *   2) si eso da 401/403: fetch DENTRO del iframe del reproductor (credentials: 'include'),
 *      exactamente como lo hace el reproductor.
 * Luego ffmpeg solo remuxa archivos locales (nada de cabeceras en la línea de comandos: sin problemas
 * de escapado en Windows). DASH (.mpd) sigue yendo por ffmpeg con las cabeceras de la sesión.
 */

export class StreamAuthError extends Error {
  permanent = true;
  auth = true;
  constructor(public status: number) {
    super(`vídeo: acceso denegado (HTTP ${status}, la sesión o la firma del vídeo caducó)`);
  }
}

export const isAuthFailure = (why: string) =>
  /acceso denegado|HTTP (401|403)\b|40[13] (Forbidden|Unauthorized)|HTTP error 40[13]/i.test(why);

type Got = { status: number; body: Buffer; type: string };
type Fetcher = { name: string; get: (url: string) => Promise<Got> };

function nodeFetcher(headers: Record<string, string>, timeoutMs: number): Fetcher {
  return {
    name: 'node',
    get: async (url) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const r = await fetch(url, { headers, redirect: 'follow', signal: ctrl.signal });
        const body = Buffer.from(await r.arrayBuffer());
        return { status: r.status, body, type: (r.headers.get('content-type') || '').toLowerCase() };
      } finally {
        clearTimeout(t);
      }
    },
  };
}

/** El iframe que hizo la petición original (o el del contenido, o la página). */
function pickFrame(page: Page, url: string): Frame | null {
  try {
    const frames = page.frames();
    const want = streamSniff(url)?.frameUrl;
    return (
      (want && frames.find((f) => f.url() === want)) ||
      frames.find((f) => f.url().includes('authoring-resources')) ||
      page.mainFrame()
    );
  } catch {
    return null;
  }
}

function pageFetcher(page: Page, manifestUrl: string): Fetcher {
  return {
    name: 'página',
    get: async (url) => {
      const frame = pickFrame(page, manifestUrl);
      if (!frame) throw new Error('sin página para descargar el vídeo');
      const r = await frame.evaluate(async (u: string) => {
        const res = await fetch(u, { credentials: 'include' });
        const buf = new Uint8Array(await res.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        return { status: res.status, b64: btoa(bin), type: res.headers.get('content-type') || '' };
      }, url);
      return { status: r.status, body: Buffer.from(r.b64, 'base64'), type: r.type.toLowerCase() };
    },
  };
}

/** Pide una URL con los fetchers en orden; 401/403 en uno -> prueba el siguiente (y se queda con el que funciona). */
class Session {
  private idx = 0;
  constructor(private readonly fetchers: Fetcher[], private readonly retries: number, private readonly log?: (m: string) => void) {}
  async get(url: string): Promise<Buffer> {
    let lastAuth = 0;
    for (let i = this.idx; i < this.fetchers.length; i++) {
      const f = this.fetchers[i];
      for (let a = 0; ; a++) {
        let r: Got;
        try {
          r = await f.get(url);
        } catch (e) {
          if (a < this.retries) {
            await new Promise((ok) => setTimeout(ok, 300 * (a + 1)));
            continue;
          }
          throw e;
        }
        if (r.status >= 200 && r.status < 300) {
          if (i !== this.idx) this.log?.(`  · vídeo: se descarga desde la página (las cookies directas dieron ${lastAuth})`);
          this.idx = i;
          return r.body;
        }
        if (r.status === 401 || r.status === 403) {
          lastAuth = r.status;
          break; // siguiente fetcher
        }
        if ((r.status >= 500 || r.status === 429 || r.status === 408) && a < this.retries) {
          await new Promise((ok) => setTimeout(ok, 400 * (a + 1)));
          continue;
        }
        throw Object.assign(new Error(`vídeo: HTTP ${r.status}`), { permanent: r.status >= 400 && r.status < 500 });
      }
    }
    throw new StreamAuthError(lastAuth || 403);
  }
}

const ATTR_URI = /URI="([^"]+)"/;

function attr(line: string, name: string): string | undefined {
  const m = line.match(new RegExp(`[:,]${name}=("([^"]*)"|[^,]*)`));
  return m ? (m[2] ?? m[1]) : undefined;
}

/** Elige la variante de mayor BANDWIDTH de un master playlist; devuelve también la pista de audio aparte, si la hay. */
export function pickVariant(master: string, base: string): { video: string; audio?: string } | null {
  const lines = master.split(/\r?\n/);
  let best: { bw: number; uri: string; audio?: string } | null = null;
  const audios = new Map<string, string>();
  for (const l of lines) {
    if (l.startsWith('#EXT-X-MEDIA:') && attr(l, 'TYPE') === 'AUDIO') {
      const uri = l.match(ATTR_URI)?.[1];
      const g = attr(l, 'GROUP-ID');
      if (uri && g && (!audios.has(g) || attr(l, 'DEFAULT') === 'YES')) audios.set(g, new URL(uri, base).href);
    }
  }
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    const uri = lines.slice(i + 1).find((x) => x.trim() && !x.startsWith('#'));
    if (!uri) continue;
    const bw = Number(attr(lines[i], 'BANDWIDTH') || 0);
    if (!best || bw > best.bw) best = { bw, uri: new URL(uri.trim(), base).href, audio: attr(lines[i], 'AUDIO') };
  }
  if (!best) return null;
  return { video: best.uri, audio: best.audio ? audios.get(best.audio) : undefined };
}

/** Baja una media playlist y todo lo que referencia a `dir`; devuelve la ruta de la playlist local. */
async function localizePlaylist(
  s: Session,
  text: string,
  base: string,
  dir: string,
  prefix: string,
  concurrency: number,
  onBytes: (n: number) => void
): Promise<string> {
  if (/#EXT-X-KEY:[^\n]*METHOD=SAMPLE-AES/i.test(text)) throw Object.assign(new Error('vídeo con DRM (SAMPLE-AES): no se puede descargar'), { permanent: true });
  const jobs: Array<{ url: string; file: string }> = [];
  let n = 0;
  const local = (u: string, ext: string) => {
    const abs = new URL(u, base).href;
    const file = `${prefix}${n++}${ext}`;
    jobs.push({ url: abs, file });
    return file;
  };
  const extOf = (u: string, def: string) => (u.split('?')[0].match(/\.(ts|m4s|mp4|aac|m4a|vtt|key|bin)$/i)?.[0] || def).toLowerCase();
  const out = text.split(/\r?\n/).map((l) => {
    const t = l.trim();
    if (!t) return l;
    if (t.startsWith('#')) {
      if (/^#EXT-X-(KEY|MAP|SESSION-KEY):/.test(t) && ATTR_URI.test(t) && !/URI="(skd|data):/i.test(t)) {
        const uri = t.match(ATTR_URI)![1];
        return t.replace(ATTR_URI, `URI="${local(uri, t.startsWith('#EXT-X-MAP') ? extOf(uri, '.mp4') : '.key')}"`);
      }
      return l;
    }
    return local(t, extOf(t, '.ts'));
  });
  await mapPool(jobs, concurrency, async (j) => {
    const body = await s.get(j.url);
    onBytes(body.length);
    await writeFile(join(dir, j.file), body);
  });
  const p = join(dir, `${prefix}.m3u8`);
  await writeFile(p, out.join('\n'));
  return p;
}

function runFfmpeg(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin(), args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => {
      if (err.length < 4000) err += String(d);
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ffmpeg: timeout tras ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject((e as NodeJS.ErrnoException).code === 'ENOENT' ? new FfmpegMissingError() : e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg (remux local) falló${err ? ': ' + err.replace(/\s+/g, ' ').trim().slice(-200) : ''}`));
    });
  });
}

export type StreamOptions = { referer: string; timeoutMs: number; retries: number; concurrency?: number; log?: (m: string) => void };

/**
 * Descarga un vídeo HLS/DASH a `dest` (mp4) usando la sesión de `page`. Escritura atómica (.part -> rename).
 * Lanza StreamAuthError (permanente, `auth`) si la CDN niega el acceso con la sesión actual: quien llama
 * puede volver a abrir el capítulo para capturar una URL nueva.
 */
export async function downloadStream(page: Page, url: string, dest: string, opts: StreamOptions): Promise<number> {
  const headers = await sessionHeadersFor(page, url, opts.referer);
  const isDash = /\.mpd$/i.test(new URL(url).pathname);
  if (isDash) return ffmpegDownload(url, dest, headers, opts.timeoutMs);

  const s = new Session([nodeFetcher(headers, Math.max(30_000, opts.timeoutMs / 10)), pageFetcher(page, url)], opts.retries, opts.log);
  const work = await mkdtemp(join(tmpdir(), 'ccna-hls-'));
  try {
    let bytes = 0;
    const add = (n: number) => (bytes += n);
    const top = (await s.get(url)).toString('utf8');
    if (!/^\s*#EXTM3U/.test(top)) throw Object.assign(new Error('vídeo: la respuesta no es un manifiesto HLS'), { permanent: true });
    let videoUrl = url;
    let videoText = top;
    let audioPl: string | undefined;
    const conc = opts.concurrency ?? 4;
    if (/#EXT-X-STREAM-INF/.test(top)) {
      const v = pickVariant(top, url);
      if (!v) throw Object.assign(new Error('vídeo: manifiesto HLS sin variantes'), { permanent: true });
      videoUrl = v.video;
      videoText = (await s.get(videoUrl)).toString('utf8');
      if (v.audio) {
        const at = (await s.get(v.audio)).toString('utf8');
        audioPl = await localizePlaylist(s, at, v.audio, work, 'a', conc, add);
      }
    }
    const videoPl = await localizePlaylist(s, videoText, videoUrl, work, 'v', conc, add);

    await mkdir(dirname(dest), { recursive: true });
    const part = dest + '.part';
    await rm(part, { force: true }).catch(() => undefined);
    const inArgs = (p: string) => ['-allowed_extensions', 'ALL', '-protocol_whitelist', 'file,crypto,data', '-i', p];
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...inArgs(videoPl)];
    if (audioPl) args.push(...inArgs(audioPl), '-map', '0:v:0', '-map', '1:a:0');
    args.push('-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', part);
    await runFfmpeg(args, opts.timeoutMs);
    const size = (await stat(part)).size;
    if (size === 0) throw new Error('ffmpeg generó un archivo vacío');
    await rm(dest, { force: true });
    await rename(part, dest);
    opts.log?.(`  · vídeo HLS descargado con la sesión (${Math.round(bytes / 1024)} KB en segmentos)`);
    return size;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}
