'use strict';
// Servidor HTTP local que imita (en pequeño) un capítulo de Netacad:
// iframe "authoring-resources", Shadow DOM, pestañas, CSS con fuentes,
// recursos que fallan a propósito. No toca internet.
const http = require('http');

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
${clean ? '' : `<img id="flaky" src="/img/flaky.png" alt="flaky">`}
${clean ? '' : `<img id="missing" src="/img/missing.png" alt="missing">`}
${clean ? '' : `<img id="down" src="/img/down.png" alt="down">`}
${clean ? '' : `<img id="fakehtml" src="/img/fakehtml.png" alt="fakehtml">`}
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
      const extra = ['slow', 'sticky', 'clean', 'hang'].filter((k) => lp.get(k) && k !== 'hang').map((k) => `${k}=${lp.get(k)}`).join('&');
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

module.exports = { createFixture };
