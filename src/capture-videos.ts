import type { HTTPResponse, Page } from 'puppeteer';

/**
 * Captura de vídeos para verlos sin conexión.
 *
 * Problema real (curso OSPF): el reproductor de Netacad es perezoso: la página solo trae un póster con
 * un botón "play" (`.media-poster` + `button.vjs-big-play-button`); el `<video>` y su fuente (URL firmada,
 * mp4 o HLS) y los subtítulos solo existen DESPUÉS de pulsar play. Como nunca se pulsaba, el HTML guardado
 * tenía solo el póster: no había nada que reproducir (ni .mp4, ni .vtt, ni <video> en todo el curso).
 *
 * Aquí se pulsa play en cada reproductor, se lee la fuente real (`currentSrc`/<source>, o el manifiesto
 * .m3u8/.mpd visto en la red cuando el reproductor usa un blob:), se leen los subtítulos (cues -> WebVTT) y se
 * sustituye el reproductor por un `<video controls>` estático. Después el flujo normal descarga la fuente
 * (mp4/webm directo, o HLS/DASH -> mp4 con ffmpeg) y la reescribe a `../assets/video/...`.
 */

export type VideoCaptureResult = {
  /** Reproductores encontrados. */
  total: number;
  /** Convertidos en `<video>` con fuente descargable. */
  captured: number;
  /** Sin fuente: se queda el póster. */
  pending: number;
  /** Con subtítulos incrustados/enlazados. */
  withTracks: number;
  /** Fuentes que serán streams (HLS/DASH) y necesitan ffmpeg. */
  streams: number;
  notes: string[];
};

export type CaptureOptions = {
  /** Espera máxima por reproductor a que aparezca el <video> con su fuente. */
  maxWaitMs?: number;
  log?: (m: string) => void;
};

export const EMPTY_CAPTURE: VideoCaptureResult = { total: 0, captured: 0, pending: 0, withTracks: 0, streams: 0, notes: [] };

type TrackInfo = { kind: string; srclang: string; label: string; isDefault: boolean; src?: string; vtt?: string };
type PlayerInfo = {
  i: number;
  title: string;
  poster: string;
  src: string;
  sources: Array<{ src: string; type: string }>;
  tracks: TrackInfo[];
  duration: number;
  hadVideo: boolean;
};

const MEDIA_RE = /\.(m3u8|mpd|mp4|webm|m4v|mov)(\?|#|$)/i;
const STREAM_RE = /\.(m3u8|mpd)(\?|#|$)/i;

export function isStreamUrl(url: string): boolean {
  return STREAM_RE.test(url);
}

/** Elige la fuente a descargar a partir de lo que dijo el reproductor y lo visto en la red. */
export function pickMediaUrl(
  info: Pick<PlayerInfo, 'src' | 'sources'>,
  sniffed: Array<{ url: string; type: string }>
): { url: string; stream: boolean } | null {
  const http = (u: string) => /^https?:\/\//i.test(u);
  const direct = [info.src, ...info.sources.map((s) => s.src)].filter((u) => u && http(u));
  // 1) mp4/webm directo
  const file = direct.find((u) => !isStreamUrl(u));
  if (file) return { url: file, stream: false };
  // 2) manifiesto declarado
  const declared = direct.find((u) => isStreamUrl(u));
  if (declared) return { url: declared, stream: true };
  // 3) blob:/MSE -> lo visto en la red tras pulsar play
  const manifest = sniffed.find((s) => isStreamUrl(s.url) || /mpegurl|dash\+xml/i.test(s.type));
  if (manifest) return { url: manifest.url, stream: true };
  const media = sniffed.find((s) => /^video\//i.test(s.type) || /\.(mp4|webm|m4v|mov)(\?|#|$)/i.test(s.url));
  if (media) return { url: media.url, stream: false };
  return null;
}

export async function captureVideos(page: Page, opts: CaptureOptions = {}): Promise<VideoCaptureResult> {
  const result: VideoCaptureResult = { ...EMPTY_CAPTURE, notes: [] };
  const sniffed: Array<{ url: string; type: string }> = [];
  const onResponse = (res: HTTPResponse) => {
    try {
      const url = res.url();
      const type = (res.headers()['content-type'] || '').toLowerCase();
      if (MEDIA_RE.test(url) || /mpegurl|dash\+xml|^video\//.test(type)) sniffed.push({ url, type });
    } catch {
      // respuesta sin cabeceras
    }
  };

  // 1) localizar reproductores
  let count = 0;
  try {
    count = await page.evaluate(listPlayers);
  } catch {
    return result;
  }
  if (count === 0) return result;
  result.total = count;

  page.on('response', onResponse);
  try {
    const maxWait = opts.maxWaitMs ?? 9000;
    for (let i = 0; i < count; i++) {
      const start = sniffed.length;
      let info: PlayerInfo | null = null;
      try {
        info = await page.evaluate(activatePlayer, i, maxWait);
      } catch (e) {
        result.notes.push(`vídeo ${i + 1}: error al activar el reproductor (${e instanceof Error ? e.message : String(e)})`);
      }
      if (!info) {
        result.pending++;
        continue;
      }
      const pick = pickMediaUrl(info, sniffed.slice(start));
      if (!pick) {
        result.pending++;
        result.notes.push(`vídeo ${i + 1} ("${info.title.slice(0, 40)}"): no se encontró la fuente (${info.hadVideo ? 'el reproductor no expuso la URL' : 'el reproductor no se montó'})`);
        continue;
      }
      const ok = await page.evaluate(buildStaticVideo, {
        i,
        mediaUrl: pick.url,
        mediaExt: 'mp4',
        poster: info.poster,
        title: info.title,
        tracks: info.tracks,
      });
      if (!ok) {
        result.pending++;
        result.notes.push(`vídeo ${i + 1}: no se pudo reemplazar el reproductor`);
        continue;
      }
      result.captured++;
      if (pick.stream) result.streams++;
      if (info.tracks.length) result.withTracks++;
    }
  } finally {
    page.off('response', onResponse);
  }
  return result;
}

// ───────────────────────── funciones que se ejecutan en la página ─────────────────────────
// (se serializan con toString: no pueden usar nada del ámbito externo)

/** Marca cada reproductor sin procesar con data-ccna-vid y devuelve cuántos hay. */
function listPlayers(): number {
  let doc: Document = document;
  const f = Array.from(document.querySelectorAll('iframe')).find((x) => (x.src || '').includes('authoring-resources')) as
    | HTMLIFrameElement
    | undefined;
  if (f && f.contentDocument) doc = f.contentDocument;
  const all: Element[] = [];
  const visit = (root: ParentNode) => {
    const kids = root.children;
    for (let k = 0; k < kids.length; k++) {
      all.push(kids[k]);
      const sr = (kids[k] as Element).shadowRoot;
      if (sr) visit(sr);
      visit(kids[k]);
    }
  };
  visit(doc);
  let n = 0;
  for (const el of all) {
    if (!el.classList || !el.classList.contains('video-container')) continue;
    if (el.hasAttribute('data-ccna-done')) continue;
    const hasPlay = !!el.querySelector('button.vjs-big-play-button, .media-poster');
    const hasVideo = !!el.querySelector('video');
    if (!hasPlay && !hasVideo) continue;
    el.setAttribute('data-ccna-vid', String(n++));
  }
  return n;
}

/** Pulsa play en el reproductor `i`, espera su <video> y devuelve fuente, póster y subtítulos. */
async function activatePlayer(i: number, maxWait: number): Promise<PlayerInfo | null> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let doc: Document = document;
  const f = Array.from(document.querySelectorAll('iframe')).find((x) => (x.src || '').includes('authoring-resources')) as
    | HTMLIFrameElement
    | undefined;
  if (f && f.contentDocument) doc = f.contentDocument;
  const find = (root: ParentNode): Element | null => {
    const kids = root.children;
    for (let k = 0; k < kids.length; k++) {
      if (kids[k].getAttribute('data-ccna-vid') === String(i)) return kids[k];
      const sr = (kids[k] as Element).shadowRoot;
      const a = sr ? find(sr) : null;
      if (a) return a;
      const b = find(kids[k]);
      if (b) return b;
    }
    return null;
  };
  const box = find(doc);
  if (!box) return null;

  const img = box.querySelector('.media-poster img') as HTMLImageElement | null;
  const btn = box.querySelector('button.vjs-big-play-button') as HTMLButtonElement | null;
  const poster = img ? img.getAttribute('src') || '' : '';
  let title = (img && img.getAttribute('alt')) || (btn && (btn.getAttribute('aria-label') || '').replace(/^\s*(play|reproducir)\s*/i, '')) || '';
  const wrapTitle = box.closest('media-view') as Element | null;
  if (!title && wrapTitle) title = wrapTitle.getAttribute('videotitle') || '';
  const hadVideoBefore = !!box.querySelector('video');

  if (btn && !hadVideoBefore) btn.click();

  const absolute = (u: string) => {
    try {
      return new URL(u, doc.baseURI).href;
    } catch {
      return u;
    }
  };

  let video: HTMLVideoElement | null = null;
  const t0 = Date.now();
  let seenAt = 0;
  while (Date.now() - t0 < maxWait) {
    video = box.querySelector('video');
    if (video) {
      const s = video.currentSrc || video.getAttribute('src') || '';
      if (s && !seenAt) seenAt = Date.now();
      if (s && !s.startsWith('blob:')) break;
      // blob: (HLS/MSE): damos un momento a que el manifiesto pase por la red
      if (s && Date.now() - seenAt > 1200) break;
    }
    await sleep(250);
  }
  if (!video) return null;

  const rawSrc = video.currentSrc || video.getAttribute('src') || '';
  const sources = Array.from(video.querySelectorAll('source')).map((s) => ({
    src: absolute(s.getAttribute('src') || ''),
    type: s.getAttribute('type') || '',
  }));
  const trackEls = Array.from(video.querySelectorAll('track'));

  // subtítulos: se fuerza la carga de las pistas y se convierten los cues a WebVTT (no depende del servidor)
  const tts: TextTrack[] = [];
  for (let k = 0; k < video.textTracks.length; k++) {
    const t = video.textTracks[k];
    if (t.kind === 'captions' || t.kind === 'subtitles') {
      tts.push(t);
      if (t.mode === 'disabled') t.mode = 'hidden';
    }
  }
  const tcues = Date.now();
  while (Date.now() - tcues < 2500 && tts.length && tts.every((t) => !t.cues || t.cues.length === 0)) await sleep(250);

  const ts = (sec: number) => {
    const ms = Math.round(sec * 1000);
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)}.${p(ms % 1000, 3)}`;
  };
  const tracks: PlayerInfo['tracks'] = [];
  for (let k = 0; k < tts.length; k++) {
    const t = tts[k];
    let vtt = '';
    if (t.cues && t.cues.length) {
      vtt = 'WEBVTT\n\n';
      for (let c = 0; c < t.cues.length; c++) {
        const cue = t.cues[c] as VTTCue;
        vtt += `${ts(cue.startTime)} --> ${ts(cue.endTime)}\n${cue.text}\n\n`;
      }
    }
    const el = trackEls.find((e) => (e.getAttribute('srclang') || '') === t.language && (e.getAttribute('label') || '') === t.label) || trackEls[k];
    const srcAttr = el ? el.getAttribute('src') || '' : '';
    const src = srcAttr && !srcAttr.startsWith('blob:') && !srcAttr.startsWith('data:') ? absolute(srcAttr) : '';
    if (!vtt && !src) continue;
    tracks.push({
      kind: t.kind,
      srclang: t.language || '',
      label: t.label || t.language || 'Subtítulos',
      isDefault: !!(el && el.hasAttribute('default')) || (k === 0 && tts.length === 1),
      ...(src ? { src } : {}),
      ...(vtt ? { vtt } : {}),
    });
  }
  // pistas <track> sin TextTrack asociado
  for (const el of trackEls) {
    const srcAttr = el.getAttribute('src') || '';
    if (!srcAttr || srcAttr.startsWith('blob:') || srcAttr.startsWith('data:')) continue;
    const abs = absolute(srcAttr);
    if (tracks.some((t) => t.src === abs)) continue;
    tracks.push({
      kind: el.getAttribute('kind') || 'captions',
      srclang: el.getAttribute('srclang') || '',
      label: el.getAttribute('label') || el.getAttribute('srclang') || 'Subtítulos',
      isDefault: el.hasAttribute('default'),
      src: abs,
    });
  }

  const duration = isFinite(video.duration) ? video.duration : 0;
  try {
    video.pause();
  } catch {
    // ya detenido
  }
  return {
    i,
    title: title.trim(),
    poster: poster ? absolute(poster) : '',
    src: rawSrc.startsWith('blob:') ? '' : rawSrc ? absolute(rawSrc) : '',
    sources,
    tracks,
    duration,
    hadVideo: true,
  };
}

/** Sustituye el reproductor `i` por un <video controls> estático con su fuente y subtítulos. */
function buildStaticVideo(a: {
  i: number;
  mediaUrl: string;
  mediaExt: string;
  poster: string;
  title: string;
  tracks: TrackInfo[];
}): boolean {
  let doc: Document = document;
  const f = Array.from(document.querySelectorAll('iframe')).find((x) => (x.src || '').includes('authoring-resources')) as
    | HTMLIFrameElement
    | undefined;
  if (f && f.contentDocument) doc = f.contentDocument;
  const find = (root: ParentNode): Element | null => {
    const kids = root.children;
    for (let k = 0; k < kids.length; k++) {
      if (kids[k].getAttribute('data-ccna-vid') === String(a.i)) return kids[k];
      const sr = (kids[k] as Element).shadowRoot;
      const x = sr ? find(sr) : null;
      if (x) return x;
      const y = find(kids[k]);
      if (y) return y;
    }
    return null;
  };
  const box = find(doc);
  if (!box) return false;

  const v = doc.createElement('video');
  v.setAttribute('controls', '');
  v.setAttribute('playsinline', '');
  v.setAttribute('preload', 'metadata');
  v.setAttribute('data-ccna-media', '1');
  v.setAttribute('data-ccna-ext', a.mediaExt);
  if (a.title) v.setAttribute('title', a.title);
  if (a.poster) v.setAttribute('poster', a.poster);
  v.setAttribute('src', a.mediaUrl);
  v.setAttribute('style', 'width:100%;height:auto;max-height:80vh;background:#000;display:block;');

  const b64 = (s: string) => {
    const bytes = new TextEncoder().encode(s);
    let bin = '';
    for (let k = 0; k < bytes.length; k++) bin += String.fromCharCode(bytes[k]);
    return btoa(bin);
  };
  for (const t of a.tracks) {
    const tr = doc.createElement('track');
    tr.setAttribute('kind', t.kind || 'captions');
    if (t.srclang) tr.setAttribute('srclang', t.srclang);
    tr.setAttribute('label', t.label || 'Subtítulos');
    if (t.isDefault) tr.setAttribute('default', '');
    if (t.vtt) {
      // en línea: Chrome bloquea <track> de archivos locales (file://) por CORS
      tr.setAttribute('src', 'data:text/vtt;charset=utf-8;base64,' + b64(t.vtt));
    } else if (t.src) {
      tr.setAttribute('src', t.src);
      tr.setAttribute('data-ccna-ext', 'vtt');
    }
    v.appendChild(tr);
  }

  while (box.firstChild) box.removeChild(box.firstChild);
  box.appendChild(v);
  (box as HTMLElement).style.height = 'auto';
  box.setAttribute('data-ccna-done', '1');
  return true;
}
