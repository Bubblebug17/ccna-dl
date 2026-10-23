'use strict';
// Servidor HTTP local que imita (en pequeño) un capítulo de Netacad:
// iframe "authoring-resources", Shadow DOM, pestañas, CSS con fuentes,
// recursos que fallan a propósito. No toca internet.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path_ = require('path');
const { spawnSync } = require('child_process');

// Vídeo real mínimo (2 s, h264+aac, ~10 KB) y su versión HLS, generados con ffmpeg y cacheados en %TEMP%.
// Sin ffmpeg -> media.ok = false y las pruebas de vídeo se omiten.
let MEDIA = null;
function makeMedia() {
  if (MEDIA) return MEDIA;
  const dir = path_.join(os.tmpdir(), 'ccna-fixture-media-v1');
  const mp4 = path_.join(dir, 'clip.mp4');
  const m3u8 = path_.join(dir, 'hls', 'index.m3u8');
  const run = (args) => spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'ignore' });
  try {
    if (!fs.existsSync(mp4) || !fs.existsSync(m3u8)) {
      fs.mkdirSync(path_.join(dir, 'hls'), { recursive: true });
      const a = run(['-f', 'lavfi', '-i', 'testsrc=size=96x64:rate=10:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', mp4]);
      const b = run(['-i', mp4, '-c', 'copy', '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_segment_filename', path_.join(dir, 'hls', 'seg%d.ts'), m3u8]);
      if (a.status !== 0 || b.status !== 0) throw new Error('ffmpeg falló');
    }
    MEDIA = { ok: true, mp4: fs.readFileSync(mp4), m3u8: fs.readFileSync(m3u8), dir };
  } catch {
    MEDIA = { ok: false };
  }
  return MEDIA;
}
const VTT = 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHola desde el vídeo\n\n00:00:01.000 --> 00:00:02.000\nSegunda línea\n\n';

// PNG de color liso (pocos KB comprimido, pero NxN píxeles al decodificar: ~4·N² bytes en RAM del renderer).
function bigPng(n, shade) {
  const zlib = require('zlib');
  const crcT = Array.from({ length: 256 }, (_, i) => {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b) => {
    let c = 0xffffffff;
    for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const t = Buffer.from(type);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(n, 0);
  ihdr.writeUInt32BE(n, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(n * 3, shade)]);
  const raw = Buffer.alloc(row.length * n);
  for (let y = 0; y < n; y++) row.copy(raw, y * row.length);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const BIG = new Map();
const bigImg = (k) => {
  if (!BIG.has(k)) BIG.set(k, bigPng(2600, (k * 37) % 255));
  return BIG.get(k);
};

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

function createFixture(opts = {}) {
  const latencyMs = opts.latencyMs || 0;
  const hits = {};
  const dl = {}; // peticiones del descargador de Node (no del navegador)
  const hung = new Set();
  const hungRes = [];
  const count = (k) => (hits[k] = (hits[k] || 0) + 1);

  const lorem =
    'Este es el contenido de prueba del capítulo. '.repeat(12) +
    'Incluye texto suficiente para pasar la verificación de contenido visible.';

  const chapterHtml = (n, q = new URLSearchParams()) => {
  const clean = q.get('clean') === '1';
  const slow = Number(q.get('slow') || 0);
  const sticky = q.get('sticky') === '1';
  const heavy = q.get('heavy') === '1';
  const video = q.get('video') || ''; // 'mp4' | 'hls' | 'none' (el reproductor nunca monta el <video>)
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Capítulo ${n}</title>
<link rel="stylesheet" href="/css/style.css">
<link rel="icon" href="/favicon.ico">
<style>@font-face{font-family:CS;src:url(/fonts/ciscoSansTT-Thin.woff2) format("woff2");}
body{font-family:CS,sans-serif;background:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'><clipPath id='c'><rect width='1' height='1'/></clipPath><g clip-path='url(%23c)'/></svg>")}
.bg{background:url(/img/ok.png)}</style>
</head><body>
<h1>Capítulo ${n}: contenido</h1>
<p>${lorem}</p>
<img id="ok" src="/img/ok.png" alt="ok">
${heavy ? Array.from({ length: 6 }, (_, k) => `<img class="big" style="width:900px;height:auto;display:block" src="/img/big${(Number(n) * 7 + k) % 40}.png" alt="grande">`).join('') + `<video id="vid" controls preload="auto" width="320" src="/media/clip${n}.mp4"></video>` : ''}
${clean ? '' : `<img id="flaky" src="/img/flaky.png" alt="flaky">`}
${clean ? '' : `<img id="missing" src="/img/missing.png" alt="missing">`}
${clean ? '' : `<img id="down" src="/img/down.png" alt="down">`}
${clean ? '' : `<img id="fakehtml" src="/img/fakehtml.png" alt="fakehtml">`}
<h3>1.1.1 Tema real de ejemplo</h3>
<p>Redes: 10.1.0.0/16 y 172.16.5.0/24 son direcciones, no temas. El router 2.2.2.2 también.</p>
<p>172.16.5.0/24 red de la sucursal con texto suficiente</p>
${video ? '<media-view></media-view>' : ''}
<a id="pka" role="button" href="/assets/files/lab_a_es-xl.pka">Laboratorio PT</a>
<img id="uniq" src="/img/u${n}.png" alt="unico">
<x-lazy></x-lazy>
<x-widget></x-widget>
<script>fetch('/blocked-tracker/t.js').catch(function(){});</script>
<script>
  // Efecto de carga: un esqueleto visible durante ${slow} ms y luego el contenido real
  // (como los efectos de 1-2 s de Netacad). sticky=1: el esqueleto nunca desaparece.
  class XLazy extends HTMLElement {
    connectedCallback() {
      const root = this.attachShadow({ mode: 'open' });
      const real = '<section><h2>CONTENIDO-CARGADO-${n}</h2><p>' + 'Texto real cargado tras el efecto. '.repeat(20) + '</p></section>';
      if (${slow} <= 0 && !${sticky}) { root.innerHTML = real; return; }
      root.innerHTML = '<div class="skeleton-box" style="height:420px;background:#ddd">esqueleto</div>';
      if (!${sticky}) setTimeout(() => { root.innerHTML = real; }, ${slow});
    }
  }
  customElements.define('x-lazy', XLazy);
</script>
${video ? `<script>
  // Reproductor perezoso como el de Netacad: solo póster + botón play; el <video> aparece al pulsar play
  class MediaView extends HTMLElement {
    connectedCallback() {
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = '<div class="video-container signed-video" data-videoids="abc-123" style="height:300px"><div class="media-poster"><img src="/img/ok.png" alt="Clip de prueba"></div><button class="vjs-big-play-button" type="button" aria-label="Play Clip de prueba"></button></div>';
      const box = root.querySelector('.video-container');
      root.querySelector('button').addEventListener('click', () => {
        if ('${video}' === 'none') return;
        const v = document.createElement('video');
        v.className = 'video-js';
        v.setAttribute('controls', '');
        box.innerHTML = '';
        box.appendChild(v);
        setTimeout(() => {
          if ('${video}' === 'mp4') {
            v.src = '/media/signed/abc123?token=1'; // URL firmada sin extensión
          } else {
            fetch('/hls/index.m3u8').then((r) => r.text()).catch(() => '');
            v.src = URL.createObjectURL(new Blob([new Uint8Array(16)], { type: 'video/mp4' })); // MSE/HLS: blob:
          }
          const t = document.createElement('track');
          t.setAttribute('kind', 'captions'); t.setAttribute('srclang', 'es'); t.setAttribute('label', 'Español'); t.setAttribute('default', '');
          t.setAttribute('src', '/media/sub.vtt');
          v.appendChild(t);
        }, 300);
      });
    }
  }
  customElements.define('media-view', MediaView);
</script>` : ''}
<script>
  class XWidget extends HTMLElement {
    connectedCallback() {
      const root = this.attachShadow({ mode: 'open' });
      const contents = ['Panel uno ' + 'texto '.repeat(30), 'Panel dos ' + 'otro '.repeat(30), 'Panel tres ' + 'más '.repeat(30)];
      let sel = 0;
      const render = () => {
        root.innerHTML = '<style>.tab{padding:4px}</style>' +
          '<div role="tablist">' + contents.map((_, i) =>
            '<button role="tab" class="tab" data-index="' + i + '" aria-selected="' + (i === sel) + '">Tab ' + (i + 1) + '</button>').join('') +
          '</div><div role="tabpanel" data-panel="' + sel + '"><p>' + contents[sel] + '</p><img src="/img/panel' + sel + '.png"></div>';
        root.querySelectorAll('[role=tab]').forEach((b, i) => b.addEventListener('click', () => { sel = i; render(); }));
      };
      const sh = new CSSStyleSheet();
      sh.replaceSync('@font-face{font-family:W;src:url(/fonts/ciscoSansTT-Light.woff2)}.tab{font-family:W}');
      root.adoptedStyleSheets = [sh];
      render();
    }
  }
  customElements.define('x-widget', XWidget);
</script>
</body></html>`;
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    count(path);
    if (!/Headless/i.test(req.headers['user-agent'] || '')) dl[path] = (dl[path] || 0) + 1;
    if (url.searchParams.get('hang') === '1' && !hung.has(req.url)) {
      hung.add(req.url); // la primera petición se queda colgada (simula un servidor que no responde)
      hungRes.push(res);
      return;
    }
    const send = (code, type, body) => {
      const go = () => {
        res.writeHead(code, { 'content-type': type });
        res.end(body);
      };
      if (latencyMs > 0) setTimeout(go, latencyMs);
      else go();
    };
    const lp = path === '/launch' ? url.searchParams : null;
    if (lp) {
      const n = (lp.get('_chapter') || '1.1.1').split('.')[0];
      const extra = ['slow', 'sticky', 'clean', 'hang', 'heavy', 'video'].filter((k) => lp.get(k) && k !== 'hang').map((k) => `${k}=${lp.get(k)}`).join('&');
      return send(200, 'text/html', `<!doctype html><html><head><title>Launch ${n}</title></head><body><main id="main-content"><h1>Curso de prueba</h1><iframe src="/authoring-resources/ch${n}.html${extra ? '?' + extra : ''}" style="width:1000px;height:900px;border:0"></iframe></main></body></html>`);
    }
    const m = path.match(/^\/launch(\d+)\.html$/);
    if (m) {
      return send(200, 'text/html', `<!doctype html><html><body><iframe src="/authoring-resources/ch${m[1]}.html" style="width:1000px;height:900px"></iframe></body></html>`);
    }
    const c = path.match(/^\/authoring-resources\/ch(\d+)\.html$/);
    if (c) return send(200, 'text/html', chapterHtml(c[1], url.searchParams));
    if (path === '/css/style.css') {
      return send(200, 'text/css', '.linked{color:#123456}');
    }
    if (path === '/fonts/ciscosanstt-light.woff2') return send(200, 'font/woff2', Buffer.alloc(80, 2));
    if (path === '/fonts/ciscosanstt-thin.woff2') return send(200, 'font/woff2', Buffer.alloc(64, 1)); // solo en minúsculas
    if (path === '/fonts/ciscoSansTT-Thin.woff2') return send(404, 'text/plain', 'nope');
    if (/^\/img\/big(\d+)\.png$/.test(path)) return send(200, 'image/png', bigImg(Number(path.match(/(\d+)/)[1])));
    if (/^\/media\/clip\d+\.mp4$/.test(path)) return send(200, 'video/mp4', Buffer.alloc(6 * 1024 * 1024, 3));
    if (path === '/media/signed/abc123') return makeMedia().ok ? send(200, 'video/mp4', makeMedia().mp4) : send(404, 'text/plain', 'sin ffmpeg');
    if (path === '/media/sub.vtt') return send(200, 'text/vtt', VTT);
    if (path === '/hls/index.m3u8') return makeMedia().ok ? send(200, 'application/vnd.apple.mpegurl', makeMedia().m3u8) : send(404, 'text/plain', 'sin ffmpeg');
    if (/^\/hls\/seg\d+\.ts$/.test(path) && makeMedia().ok) {
      const f = path_.join(makeMedia().dir, path.slice(1));
      return fs.existsSync(f) ? send(200, 'video/mp2t', fs.readFileSync(f)) : send(404, 'text/plain', 'nope');
    }
    if (path === '/img/ok.png' || /^\/img\/(panel|u)\d+\.png$/.test(path)) return send(200, 'image/png', PNG);
    if (path === '/img/flaky.png') {
      return hits[path] <= 2 ? send(503, 'text/plain', 'busy') : send(200, 'image/png', PNG);
    }
    if (path === '/img/down.png') return send(503, 'text/plain', 'siempre caído');
    if (path === '/img/fakehtml.png') return send(200, 'text/html', '<html><body>Please log in</body></html>');
    if (path === '/assets/files/lab_a_es-xl.pka') return send(200, 'application/octet-stream', Buffer.alloc(200, 7));
    if (path === '/blocked-tracker/t.js') return send(200, 'application/javascript', '/* tracker */');
    if (path === '/favicon.ico') return send(200, 'image/x-icon', PNG);
    return send(404, 'text/plain', 'not found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        base: `http://127.0.0.1:${port}`,
        hits,
        dl,
        resetHits: () => {
          Object.keys(hits).forEach((k) => delete hits[k]);
          Object.keys(dl).forEach((k) => delete dl[k]);
        },
        close: () => new Promise((r) => {
          hungRes.forEach((x) => x.destroy());
          server.closeAllConnections?.();
          server.close(r);
        }),
      });
    });
  });
}

module.exports = { createFixture, makeMedia };
