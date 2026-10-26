import { spawn } from 'child_process';
import { ffmpegBin } from './platform';
import { mkdir, rename, rm, stat } from 'fs/promises';
import { dirname } from 'path';

/** URL de un manifiesto de streaming (HLS/DASH) por su extensión. */
export function isStreamManifestUrl(url: string): boolean {
  try {
    return /\.(m3u8|mpd)$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export class FfmpegMissingError extends Error {
  permanent = true;
  constructor() {
    super('ffmpeg no está instalado (hace falta para vídeos HLS/DASH; instálalo o define FFMPEG_PATH)');
  }
}

/**
 * Argumentos de ffmpeg para convertir un manifiesto HLS/DASH en un mp4 local sin recodificar.
 * Las cabeceras (cookies, Referer) viajan en -headers: nunca se escriben en logs ni mensajes de error.
 */
export function buildFfmpegArgs(url: string, destPart: string, headers: Record<string, string>): string[] {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
  const ua = headers['User-Agent'] || headers['user-agent'];
  if (ua) args.push('-user_agent', ua);
  const hdr = Object.entries(headers)
    .filter(([k]) => k.toLowerCase() !== 'user-agent')
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join('');
  if (hdr) args.push('-headers', hdr);
  args.push('-i', url, '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', destPart);
  return args;
}

// AVERROR_HTTP_* de ffmpeg: -MKTAG(0xF8, '4', 'x', 'x')
const AVERROR_HTTP: Record<number, string> = {
  [-0x303034f8]: 'HTTP 400',
  [-0x313034f8]: 'HTTP 401',
  [-0x333034f8]: 'HTTP 403',
  [-0x343034f8]: 'HTTP 404',
  [-0x585834f8]: 'HTTP 4xx',
  [-0x585835f8]: 'HTTP 5xx',
};

/**
 * Código de salida legible. En Windows ffmpeg sale con su AVERROR como entero de 32 bits sin signo:
 * 3436169992 = 0xCCCFCB08 = -0x333034F8 = AVERROR_HTTP_FORBIDDEN (403). Se traduce en vez de mostrar el número.
 */
export function ffmpegExitLabel(code: number | null): string {
  if (code == null) return 'interrumpido';
  if (code >= 0 && code < 256) return `código ${code}`;
  const signed = code | 0;
  return AVERROR_HTTP[signed] ?? `código 0x${(code >>> 0).toString(16).toUpperCase()}`;
}

/** Descarga un stream HLS/DASH a `dest` (mp4) con ffmpeg; escritura atómica (.part -> rename). */
export async function ffmpegDownload(
  url: string,
  dest: string,
  headers: Record<string, string>,
  timeoutMs = 20 * 60_000
): Promise<number> {
  await mkdir(dirname(dest), { recursive: true });
  const part = dest + '.part';
  await rm(part, { force: true }).catch(() => undefined);
  const bin = ffmpegBin();
  const args = buildFfmpegArgs(url, part, headers);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
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
      // el comando lleva cookies en -headers: solo se devuelve la salida de error de ffmpeg, recortada
      const msg = err.replace(/\s+/g, ' ').trim().slice(-200);
      const http = msg.match(/HTTP error (\d{3})|Server returned (\d{3})|\b(40[13]) (?:Forbidden|Unauthorized)/i);
      const status = http ? http[1] || http[2] || http[3] : (AVERROR_HTTP[(code ?? 0) | 0]?.match(/\d{3}/)?.[0] ?? '');
      const e = new Error(`ffmpeg falló (${ffmpegExitLabel(code)})${msg ? ': ' + msg : ''}`) as Error & { permanent?: boolean; auth?: boolean };
      if (status && status !== '408' && status !== '429' && status[0] === '4') e.permanent = true;
      if (status === '401' || status === '403') e.auth = true;
      reject(e);
    });
  });

  try {
    const size = (await stat(part)).size;
    if (size === 0) throw new Error('ffmpeg generó un archivo vacío');
    await rm(dest, { force: true });
    await rename(part, dest);
    return size;
  } catch (e) {
    await rm(part, { force: true }).catch(() => undefined);
    throw e;
  }
}
