#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
/**
 * Validador OFFLINE de cursos descargados con ccna-dl (HTML).
 * No necesita login, red ni dependencias: solo Node >= 16.
 *
 * Uso:
 *   node scripts/validate-download.js                  # valida todos los cursos de la carpeta del proyecto
 *   node scripts/validate-download.js --root D:\cursos # otra carpeta raíz
 *   node scripts/validate-download.js --course Ciber   # solo cursos cuyo nombre contenga "Ciber"
 *   node scripts/validate-download.js --out informe.md --json informe.json
 *   node scripts/validate-download.js --min-bytes 30000 --min-text 300
 *
 * Códigos de salida: 0 = sin problemas graves, 1 = hay problemas graves, 2 = error de uso.
 * No modifica ni borra nada dentro de las carpetas de los cursos.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ───────────────────────── Argumentos ─────────────────────────
function parseArgs(argv) {
  const o = {
    root: path.resolve(__dirname, '..'),
    course: null,
    out: null,
    json: null,
    minBytes: 30000,
    minText: 300,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--root') o.root = path.resolve(next());
    else if (a === '--course') o.course = next();
    else if (a === '--out') o.out = next();
    else if (a === '--json') o.json = next();
    else if (a === '--min-bytes') o.minBytes = Number(next());
    else if (a === '--min-text') o.minText = Number(next());
    else if (a === '--quiet') o.quiet = true;
    else if (a === '-h' || a === '--help') {
      console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^[\s\S]*?\/\*\*/, ''));
      process.exit(0);
    } else {
      console.error('Opción desconocida: ' + a);
      process.exit(2);
    }
  }
  if (!o.out) o.out = path.join(o.root, 'validation-report.md');
  return o;
}

// ───────────────────────── Utilidades ─────────────────────────
const SKIP_DIRS = new Set(['node_modules', '.git', 'lib', 'src', 'scripts', 'img', '.github', '.vscode']);
const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'avif']);
const FONT_EXT = new Set(['woff2', 'woff', 'ttf', 'otf', 'eot']);
const BIN_EXT = new Set([...IMG_EXT, ...FONT_EXT, 'pdf', 'zip', 'mp4', 'webm', 'vtt', 'mp3', 'pka', 'pkt', 'pksz', 'pkz']);
const REMOTE_HOST_RE = /(^|\.)(netacad\.com|cisco\.com|ciscolearning\.com|cdn[\w.-]*|cloudfront\.net|akamai[\w.]*|googleapis\.com|gstatic\.com|jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|fonts\.g[\w.]+)$/i;
const IGNORE_HOST_RE = /(^|\.)(w3\.org|schema\.org|purl\.org)$/i;

const extOf = (p) => {
  const m = /\.([a-z0-9]+)$/i.exec(p.split(/[?#]/)[0]);
  return m ? m[1].toLowerCase() : '';
};

function walk(dir, cb) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, cb);
    else if (e.isFile()) cb(full);
  }
}

function decodeEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const human = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B');

/** Convierte id de capítulo/archivo a forma comparable. "1" -> "1.1" (ccna-dl guarda x.1 como x.html). */
function normChapter(id) {
  return /^\d+$/.test(id) ? id + '.1' : id;
}
function cmpChapter(a, b) {
  const pa = normChapter(a).split('.').map(Number);
  const pb = normChapter(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// ───────────────────────── Capítulos / subtemas sospechosos ─────────────────────────
/** Sección real de un id de archivo: "1" -> "1.1", "2.3" -> "2.3". */
function sectionOf(id) {
  return /^\d+\.\d+$/.test(id) ? id : /^\d+$/.test(id) ? id + '.1' : null;
}

/**
 * ¿Un subtema (n.n.n + título) es falso? Casos reales: IPs/redes del texto ("10.1.0.0/16" -> "10.1.0" con
 * título ".0/16"), números que no pertenecen a la sección del capítulo ("172.16.5" en 1.3).
 */
function bogusSubtopic(sub, title, section) {
  const t = (title || '').trim();
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(sub)) return 'número con forma de IP';
  if (!t) return 'sin título';
  if (/^[./]/.test(t) && !/^\.\s+\p{L}/u.test(t)) return 'título "' + t.slice(0, 20) + '" (resto de una IP/red)';
  if (!/\p{L}/u.test(t)) return 'título sin letras ("' + t.slice(0, 20) + '")';
  if (section && !sub.startsWith(section + '.')) return 'no pertenece a la sección ' + section;
  return null;
}

/** Subtemas (data-sub) guardados en un capítulo, con el título del encabezado que los sigue. */
function subtopicsOfHtml(html) {
  const out = [];
  const seen = new Set();
  const re = /\sdata-sub="(\d+(?:\.\d+)*)"/g;
  let m;
  while ((m = re.exec(html))) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    const chunk = html.slice(m.index, m.index + 8000);
    // el primer encabezado puede ser basura sin letras ("<h1>\u00a0</h1>"): se usa el primero con texto
    const cands = [...chunk.matchAll(/class="[^"]*headingtitle[^"]*"[^>]*>([^<]+)/gi), ...chunk.matchAll(/<h[1-6][^>]*>(?:<[^>]+>)*([^<]+)/gi)].map((x) => decodeEntities(x[1]).trim());
    const found = cands.find((c) => /\p{L}/u.test(c));
    out.push({ sub: m[1], title: found || 'Subtema ' + m[1] });
  }
  return out;
}

const QUIZ_TITLE_RE = /^\s*(prueba de mi conocimiento|prueba de conocimiento|knowledge check|comprueba tu conocimiento|mon contr[oô]le)/i;

// ───────────────────────── Parseo HTML ligero ─────────────────────────
const TAG_RE = /<([a-zA-Z][\w:-]*)((?:\s+[^\s"'<>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
const ATTR_RE = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttrs(s) {
  const attrs = {};
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(s))) {
    attrs[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
  }
  return attrs;
}

function stripDataUris(css) {
  // Quita el contenido de url("data:...") para no tomar como referencias los url(#id) / url(%23id) internos del SVG incrustado.
  let out = '';
  let i = 0;
  const re = /url\(\s*(\\?["']?)data:/gi;
  for (;;) {
    re.lastIndex = i;
    const m = re.exec(css);
    if (!m) break;
    out += css.slice(i, m.index) + 'url(data:)';
    let j = m.index + m[0].length;
    const q = m[1].replace('\\', '');
    if (q) {
      while (j < css.length) {
        if (css[j] === '\\') j += 2;
        else if (css[j] === q) break;
        else j++;
      }
      j = css.indexOf(')', j);
    } else {
      j = css.indexOf(')', j);
    }
    i = j < 0 ? css.length : j + 1;
  }
  return out + css.slice(i);
}

/** Extrae url(...) y @import de un texto CSS. */
function cssRefs(css) {
  const refs = [];
  let m;
  css = stripDataUris(css);
  const re = /url\(\s*(?:\\?["']?)([^"')\s]+?)(?:\\?["']?)\s*\)/gi;
  while ((m = re.exec(css))) refs.push(m[1]);
  const re2 = /@import\s+(?:url\(\s*)?\\?["']([^"']+?)\\?["']/gi;
  while ((m = re2.exec(css))) refs.push(m[1]);
  return refs;
}

/** Analiza un HTML de capítulo y devuelve referencias, señales de carga y contenido oculto. */
function analyzeHtml(html) {
  const info = {
    title: '',
    refs: [], // {kind, url}
    spinners: [],
    errorTexts: [],
    hidden: { tabs: 0, panels: 0, tabsInactive: 0, panelsHidden: 0, accordionsClosed: 0, mbar: 0, hiddenAttr: 0, ariaHidden: 0 },
    quiz: { loaders: 0, forms: 0 },
    textLen: 0,
    loginPage: false,
    hasDoctype: /^\s*<!doctype html/i.test(html),
    hasClosingHtml: /<\/html>\s*$/i.test(html),
    absoluteInText: [],
    badFragmentRefs: 0,
    video: { bigPlay: 0, videos: 0, offline: 0, tracks: 0 },
  };

  const tm = /<title>([^<]*)<\/title>/i.exec(html);
  if (tm) info.title = decodeEntities(tm[1]).trim();

  // JSON de hojas adoptadas
  let adopted = '';
  html = html.replace(/<script id="__ccna_adopted"[^>]*>([\s\S]*?)<\/script>/i, (_, j) => {
    try {
      adopted = JSON.parse(j).join('\n');
    } catch (e) {
      info.errorTexts.push('JSON de estilos adoptados corrupto');
    }
    return '';
  });
  // quitar scripts (incluye el loader que añade ccna-dl)
  const scriptCount = (html.match(/<script\b/gi) || []).length;
  html = html.replace(/<script\b[\s\S]*?<\/script>/gi, '');
  // estilos <style>
  let styleText = adopted;
  html = html.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_, c) => {
    styleText += '\n' + c;
    return '';
  });
  for (const u of cssRefs(styleText)) info.refs.push({ kind: 'css', url: u });

  // etiquetas
  let m;
  TAG_RE.lastIndex = 0;
  const tabsByPanel = [];
  while ((m = TAG_RE.exec(html))) {
    const tag = m[1].toLowerCase();
    const a = parseAttrs(m[2]);
    const add = (kind, url) => {
      if (url) info.refs.push({ kind, url: decodeEntities(url.trim()) });
    };
    if (tag === 'img' || tag === 'source' || tag === 'video' || tag === 'audio' || tag === 'track' || tag === 'embed' || tag === 'iframe') {
      add(tag === 'iframe' ? 'iframe' : tag, a.src);
      add('poster', a.poster);
      if (a.srcset) for (const p of a.srcset.split(',')) add('srcset', p.trim().split(/\s+/)[0]);
    } else if (tag === 'link') {
      const rel = (a.rel || '').toLowerCase();
      if (/stylesheet|icon|font|preload/.test(rel)) add('link-' + rel, a.href);
    } else if (tag === 'a') {
      add('a', a.href);
    } else if (tag === 'object') {
      add('object', a.data);
    }
    for (const k of ['data-pdf', 'data-href', 'data-src', 'data-url', 'data-download']) if (a[k]) add(k, a[k]);
    if (a.poster && tag !== 'video') add('poster', a.poster);
    if (a.style && a.style.includes('url(')) for (const u of cssRefs(decodeEntities(a.style))) info.refs.push({ kind: 'style-attr', url: u });

    if (tag === 'video') {
      info.video.videos++;
      if ('data-ccna-media' in a) info.video.offline++;
    }
    if (tag === 'track') info.video.tracks++;
    // señales de "cargando"
    const cls = (a.class || '').toLowerCase();
    const inlineHidden = /display\s*:\s*none|visibility\s*:\s*hidden/i.test(a.style || '') || 'hidden' in a || a['aria-hidden'] === 'true';
    if (tag === 'sgpulse-loader' || /\b(loading-spinner|spinner|is-loading)\b/.test(cls) || a['aria-busy'] === 'true') {
      info.spinners.push({ tag, cls: cls.slice(0, 50), hidden: inlineHidden });
    }
    if (/\bvjs-big-play-button\b/.test(cls)) info.video.bigPlay++;
    if (tag === 'assessment-loader' || /cyu-quiz|assessment-loader/.test(cls)) info.quiz.loaders++;
    if (tag === 'form' && /cyu-quiz/.test(cls)) info.quiz.forms++;

    // contenido oculto
    if (a.role === 'tab') info.hidden.tabs++;
    if (a.role === 'tabpanel') info.hidden.panels++;
    if (a.role === 'tab' && a['aria-selected'] === 'false') info.hidden.tabsInactive++;
    if (a.role === 'tabpanel' && ('hidden' in a || /display\s*:\s*none/i.test(a.style || ''))) info.hidden.panelsHidden++;
    if (a['aria-expanded'] === 'false' && /accordion|collapse|toggle|expand/.test(cls + ' ' + (a.id || ''))) info.hidden.accordionsClosed++;
    if (/\bmbar-(content|buttons)-wrapper\b/.test(cls)) info.hidden.mbar++;
    if ('hidden' in a) info.hidden.hiddenAttr++;
    if (a['aria-hidden'] === 'true') info.hidden.ariaHidden++;
  }

  // texto visible aproximado (sin etiquetas)
  const text = decodeEntities(html.replace(/<template[^>]*>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  info.textLen = text.length;
  info.text = text;

  const ERR = [
    [/something went wrong|algo sali[oó] mal/i, 'mensaje "algo salió mal"'],
    [/error (loading|al cargar)|failed to load|no se pudo cargar/i, 'mensaje de error de carga'],
    [/access denied|acceso denegado|403 forbidden|404 not found|page not found|p[aá]gina no encontrada/i, 'acceso denegado / 404'],
    [/session (has )?expired|sesi[oó]n (ha )?expir/i, 'sesión expirada'],
    [/\b(loading|cargando)\.\.\.|\bcargando…|\bloading…/i, 'texto "Cargando..."'],
  ];
  for (const [re, label] of ERR) if (re.test(text)) info.errorTexts.push(label);
  if (/auth\.netacad|name="password"|type="password"|sign in to|iniciar sesi[oó]n en/i.test(html) && info.textLen < 5000) info.loginPage = true;

  // URLs absolutas en cualquier parte (texto/JSON/atributos) que sean recursos
  const absRe = /https?:\/\/[^\s"'<>)\\]+/gi;
  const seen = new Set();
  while ((m = absRe.exec(html + '\n' + styleText))) {
    const u = m[0].replace(/[,;.]+$/, '');
    if (/%23[\w-]+$/.test(u) && /authoring-resources\/%23/.test(u)) {
      info.badFragmentRefs++;
      continue;
    }
    if (seen.has(u)) continue;
    seen.add(u);
    let host = '';
    try {
      host = new URL(u).hostname;
    } catch (e) {
      continue;
    }
    if (IGNORE_HOST_RE.test(host)) continue;
    if (BIN_EXT.has(extOf(u)) || extOf(u) === 'css' || extOf(u) === 'js') info.absoluteInText.push(u);
  }
  info.scriptCount = scriptCount;
  return info;
}

// ───────────────────────── Comprobación de archivos de assets ─────────────────────────
function sniffProblem(file, size) {
  const ext = extOf(file);
  if (size === 0) return 'archivo vacío (0 bytes)';
  let fd, buf;
  try {
    fd = fs.openSync(file, 'r');
    buf = Buffer.alloc(Math.min(512, size));
    fs.readSync(fd, buf, 0, buf.length, 0);
  } catch (e) {
    return 'no se puede leer: ' + e.code;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  const head = buf.toString('latin1');
  const trimmed = head.replace(/^\uFEFF/, '').trimStart();
  const looksHtml = /^<(!doctype html|html|head|body)/i.test(trimmed);
  const looksJsonErr = /^\{\s*"(error|message|status)"/i.test(trimmed) && size < 2000;
  if (BIN_EXT.has(ext) || ext === 'css') {
    if (looksHtml) return 'contiene HTML (página de error/login) en vez de ' + ext.toUpperCase();
    if (looksJsonErr && ext !== 'json') return 'contiene un JSON de error';
  }
  const b = buf;
  switch (ext) {
    case 'png':
      if (!(b[0] === 0x89 && b[1] === 0x50)) return 'no es un PNG válido';
      break;
    case 'jpg':
    case 'jpeg':
      if (!(b[0] === 0xff && b[1] === 0xd8)) return 'no es un JPEG válido';
      break;
    case 'gif':
      if (!head.startsWith('GIF8')) return 'no es un GIF válido';
      break;
    case 'webp':
      if (!(head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP')) return 'no es un WebP válido';
      break;
    case 'svg':
      if (!/<svg|<\?xml/i.test(trimmed) && !/<svg/i.test(fs.readFileSync(file, 'latin1').slice(0, 4096))) return 'no parece un SVG';
      break;
    case 'pdf':
      if (!head.startsWith('%PDF')) return 'no es un PDF válido';
      break;
    case 'woff':
      if (!head.startsWith('wOFF')) return 'no es una fuente WOFF válida';
      break;
    case 'woff2':
      if (!head.startsWith('wOF2')) return 'no es una fuente WOFF2 válida';
      break;
    case 'mp4':
      if (head.slice(4, 8) !== 'ftyp' && head.slice(4, 8) !== 'moov') return 'no es un MP4 válido (sin cabecera ftyp)';
      break;
    case 'webm':
      if (!(b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3)) return 'no es un WebM válido';
      break;
    case 'vtt':
      if (!/^\uFEFF?WEBVTT/.test(head)) return 'no es un WebVTT válido (falta la cabecera WEBVTT)';
      break;
    case 'zip':
    case 'pkz':
      if (!head.startsWith('PK')) return 'no es un ZIP válido';
      break;
    default:
  }
  return null;
}

// ───────────────────────── Validación de un curso ─────────────────────────
function isCourseDir(dir) {
  return fs.existsSync(path.join(dir, 'chapters')) || (fs.existsSync(path.join(dir, 'assets')) && fs.existsSync(path.join(dir, 'index.html')));
}

function findCourses(root) {
  const out = [];
  let ents = [];
  try {
    ents = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const e of ents) {
    if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
    const full = path.join(root, e.name);
    if (isCourseDir(full)) out.push(full);
  }
  return out.sort();
}

function resolveLocal(fromFile, rawUrl, courseDir) {
  let u = rawUrl.trim().replace(/^\\+|\\+$/g, '');
  if (!u || u.startsWith('#') || /^(data|blob|javascript|mailto|tel):/i.test(u)) return { skip: true };
  if (/^(https?:)?\/\//i.test(u)) return { remote: u.startsWith('//') ? 'https:' + u : u };
  u = u.split('#')[0].split('?')[0];
  if (!u) return { skip: true };
  let dec = u;
  try {
    dec = decodeURIComponent(u);
  } catch (e) {
    /* deja tal cual */
  }
  const abs = dec.startsWith('/') ? path.join(courseDir, dec) : path.resolve(path.dirname(fromFile), dec);
  return { abs };
}

function validateCourse(courseDir, opt) {
  const name = path.basename(courseDir);
  const res = {
    name,
    dir: courseDir,
    indexExists: false,
    indexChapters: [],
    chapters: [], // por capítulo
    problems: { graves: [], avisos: [], info: [] },
    assets: { total: 0, bytes: 0, zero: [], corrupt: [], duplicates: [], orphans: [] },
    refs: { checked: 0, missing: 0, remote: 0 },
    totals: { chapterFiles: 0, chapterBytes: 0 },
  };
  const P = res.problems;
  const chaptersDir = path.join(courseDir, 'chapters');
  const assetsDir = path.join(courseDir, 'assets');

  // --- índice ---
  const indexFile = path.join(courseDir, 'index.html');
  let indexFiles = [];
  if (fs.existsSync(indexFile)) {
    res.indexExists = true;
    const idx = fs.readFileSync(indexFile, 'utf8');
    if (idx.length < 500) P.graves.push('index.html demasiado pequeño (' + idx.length + ' bytes)');
    const set = new Set();
    const re = /data-file="([^"]+)"/g;
    let m;
    while ((m = re.exec(idx))) set.add(decodeEntities(m[1]));
    if (!set.size) {
      const re2 = /href="(chapters\/[^"#]+)/g;
      while ((m = re2.exec(idx))) set.add(decodeEntities(m[1]));
    }
    indexFiles = [...set];
    // subtemas falsos en la barra lateral (IPs tomadas por "1.2.3 Título")
    const subRe = /<li class="sub"><a href="([^"#]+)#sub-([^"]+)"[^>]*><span class="num">([^<]*)<\/span>\s*<span class="t">([^<]*)<\/span>/g;
    const fakeSubs = [];
    let subTotal = 0;
    while ((m = subRe.exec(idx))) {
      subTotal++;
      const id = decodeEntities(m[1]).replace(/^chapters\//, '').replace(/\.html$/i, '');
      const why = bogusSubtopic(decodeEntities(m[3]), decodeEntities(m[4]), sectionOf(id));
      if (why) fakeSubs.push(decodeEntities(m[3]) + ' "' + decodeEntities(m[4]).slice(0, 24) + '" en ' + id + ' (' + why + ')');
    }
    res.indexSubtopics = { total: subTotal, fake: fakeSubs.length };
    if (fakeSubs.length)
      P.avisos.push(
        'capítulo sospechoso: el índice tiene ' + fakeSubs.length + ' de ' + subTotal + ' subtemas falsos (direcciones IP/redes tomadas por subtemas): ' + fakeSubs.slice(0, 4).join(' | ') + (fakeSubs.length > 4 ? ' …' : '') + '. Se limpia con: node scripts/clean-fake-chapters.js --apply'
      );
    if (!indexFiles.length) P.graves.push('index.html no enlaza a ningún capítulo');
    const iframeSrc = /<iframe[^>]*src="([^"]*)"/i.exec(idx);
    if (iframeSrc && iframeSrc[1] && !fs.existsSync(path.join(courseDir, iframeSrc[1].split('#')[0]))) P.graves.push('el iframe inicial del índice apunta a un archivo inexistente: ' + iframeSrc[1]);
  } else {
    P.graves.push('Falta index.html (no hay índice para navegar el curso).');
  }

  // --- capítulos presentes ---
  let chapterFiles = [];
  try {
    chapterFiles = fs.readdirSync(chaptersDir).filter((f) => !f.startsWith('.')).sort((a, b) => cmpChapter(a.replace(/\.html$/i, ''), b.replace(/\.html$/i, '')));
  } catch (e) {
    P.graves.push('Falta la carpeta chapters/.');
  }
  const nonHtml = chapterFiles.filter((f) => !/\.html$/i.test(f));
  for (const f of nonHtml) P.avisos.push('Archivo no HTML dentro de chapters/: ' + f);
  chapterFiles = chapterFiles.filter((f) => /\.html$/i.test(f));
  res.totals.chapterFiles = chapterFiles.length;

  const present = new Set(chapterFiles.map((f) => 'chapters/' + f));
  for (const f of indexFiles) if (!present.has(f)) P.graves.push('El índice enlaza a un capítulo que no existe: ' + f);
  if (res.indexExists) {
    const unlisted = chapterFiles.filter((f) => !indexFiles.includes('chapters/' + f));
    if (unlisted.length)
      P.graves.push(
        `El índice (index.html) solo enlaza ${indexFiles.length} de ${chapterFiles.length} capítulos; ${unlisted.length} están en disco pero no en el índice (${unlisted.slice(0, 6).join(', ')}${unlisted.length > 6 ? '…' : ''}). Se arregla regenerando el índice (--reindex o volver a ejecutar la descarga).`
      );
  }

  // --- ids duplicados en el resumen de la descarga (dos elementos que escriben el mismo archivo) ---
  try {
    const sumPath = ['descarga-resumen.json', 'download-summary.json'].map((n) => path.join(courseDir, n)).find((p) => fs.existsSync(p));
    if (sumPath) {
      const sum = JSON.parse(fs.readFileSync(sumPath, 'utf8'));
      const list = Array.isArray(sum) ? sum : sum.capitulos || sum.chapters || sum.outcomes || [];
      const by = new Map();
      for (const e of list) {
        const id = e && (e.chapter || e.capitulo);
        if (!id) continue;
        if (!by.has(id)) by.set(id, []);
        by.get(id).push(e.url || e.chapterUrl || '');
      }
      const dups = [...by.entries()].filter(([, u]) => u.length > 1);
      res.duplicateChapterIds = dups.map(([id]) => id);
      for (const [id, urlsOfId] of dups) {
        const q = urlsOfId.map((u) => (/_chapter=([\d.]+)/.exec(u) || [])[1]).filter(Boolean);
        P.graves.push('capítulo sospechoso: el id "' + id + '" aparece ' + urlsOfId.length + ' veces en ' + path.basename(sumPath) + (q.length ? ' (_chapter=' + q.join(', ') + ')' : '') + ': el último sobrescribió a los demás en chapters/' + id + '.html');
      }
    }
  } catch (e) {
    /* resumen ilegible: se ignora */
  }

  // --- huecos en la numeración ---
  const ids = chapterFiles.map((f) => normChapter(f.replace(/\.html$/i, '')));
  const byModule = new Map();
  for (const id of ids) {
    const [mod, sec] = id.split('.');
    if (!byModule.has(mod)) byModule.set(mod, new Set());
    byModule.get(mod).add(Number(sec));
  }
  const gaps = [];
  for (const [mod, secs] of byModule) {
    const max = Math.max(...secs);
    for (let s = 0; s <= max; s++) if (!secs.has(s) && !(s === 0 && secs.has(1) && false)) gaps.push(mod + '.' + s);
  }
  // el .0 (introducción) no siempre existe: se avisa igual pero separado
  const gapsCrit = gaps.filter((g) => !g.endsWith('.0'));
  if (gapsCrit.length) P.avisos.push('Posibles capítulos faltantes (huecos en la numeración): ' + gapsCrit.join(', '));
  const gapsIntro = gaps.filter((g) => g.endsWith('.0'));
  if (gapsIntro.length) P.info.push('Módulos sin página de introducción .0: ' + gapsIntro.join(', '));
  res.modules = [...byModule.keys()].sort((a, b) => a - b);

  // --- assets: inventario ---
  const assetFiles = new Map(); // abs -> {size}
  const hashMap = new Map();
  walk(assetsDir, (f) => {
    const st = fs.statSync(f);
    assetFiles.set(f, { size: st.size });
    res.assets.total++;
    res.assets.bytes += st.size;
    if (st.size === 0) res.assets.zero.push(path.relative(courseDir, f));
    const prob = st.size === 0 ? null : sniffProblem(f, st.size);
    if (prob) res.assets.corrupt.push({ file: path.relative(courseDir, f), problem: prob });
    if (st.size > 0) {
      const h = crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
      if (!hashMap.has(h)) hashMap.set(h, []);
      hashMap.get(h).push(path.relative(courseDir, f));
    }
  });
  for (const [, files] of hashMap) {
    if (files.length > 1) res.assets.duplicates.push(files);
  }
  const referenced = new Set();
  const checkedRefs = new Map(); // abs -> exists

  // --- archivos CSS: referencias internas ---
  const cssProblems = [];
  for (const [f] of assetFiles) {
    if (extOf(f) !== 'css') continue;
    const css = fs.readFileSync(f, 'utf8');
    for (const u of cssRefs(css)) {
      const r = resolveLocal(f, u, courseDir);
      if (r.skip) continue;
      res.refs.checked++;
      if (r.remote) {
        res.refs.remote++;
        cssProblems.push(path.relative(courseDir, f) + ' → URL remota: ' + r.remote.slice(0, 120));
      } else {
        referenced.add(r.abs);
        if (!fs.existsSync(r.abs)) {
          res.refs.missing++;
          cssProblems.push(path.relative(courseDir, f) + ' → no existe: ' + u.slice(0, 100));
        } else referenced.add(r.abs);
      }
    }
  }
  if (cssProblems.length) P.graves.push(...cssProblems.slice(0, 20).map((s) => 'CSS: ' + s), ...(cssProblems.length > 20 ? ['CSS: … y ' + (cssProblems.length - 20) + ' más'] : []));

  // --- cada capítulo ---
  const titles = new Map();
  for (const f of chapterFiles) {
    const full = path.join(chaptersDir, f);
    const st = fs.statSync(full);
    const chap = { file: 'chapters/' + f, id: f.replace(/\.html$/i, ''), bytes: st.size, issues: [], warnings: [], notes: [] };
    res.totals.chapterBytes += st.size;
    if (st.size === 0) {
      chap.issues.push('archivo vacío (0 bytes)');
      res.chapters.push(chap);
      continue;
    }
    const html = fs.readFileSync(full, 'utf8');
    const a = analyzeHtml(html);
    chap.title = a.title;
    chap.textLen = a.textLen;
    if (!a.hasDoctype) chap.issues.push('no empieza con <!DOCTYPE html>');
    if (!a.hasClosingHtml) chap.issues.push('HTML truncado: no termina en </html>');
    if (st.size < opt.minBytes) chap.issues.push('muy pequeño (' + human(st.size) + ' < ' + human(opt.minBytes) + ')');
    if (a.textLen < opt.minText) chap.issues.push('poco texto (' + a.textLen + ' caracteres < ' + opt.minText + ')');
    if (a.loginPage) chap.issues.push('parece una página de login');
    for (const e of a.errorTexts) chap.issues.push('texto sospechoso: ' + e);
    // <sgpulse-loader> es parte de la estructura normal de la página (1 por capítulo); solo cuentan los demás.
    const visibleSpinners = a.spinners.filter((s) => !s.hidden && s.tag !== 'sgpulse-loader');
    const pulse = a.spinners.filter((s) => s.tag === 'sgpulse-loader').length;
    if (pulse > 1) chap.warnings.push(pulse + ' <sgpulse-loader> en el HTML (normal: 1)');
    if (visibleSpinners.length) chap.warnings.push(visibleSpinners.length + ' loader(s)/spinner(s) en el HTML sin ocultar (' + [...new Set(visibleSpinners.map((s) => s.tag + (s.cls ? '.' + s.cls : '')))].slice(0, 3).join(', ') + ')');
    if (a.quiz.loaders) chap.notes.push(a.quiz.loaders + ' cuestionario(s)/evaluación(es) interactivo(s) (no se resuelven offline)');
    if (a.quiz.forms) chap.warnings.push(a.quiz.forms + ' formulario(s) de quiz sin resolver');
    const h = a.hidden;
    if (h.tabs > h.panels) chap.issues.push('CONTENIDO DE PESTAÑAS NO GUARDADO: ' + h.tabs + ' pestañas pero solo ' + h.panels + ' panel(es) en el HTML (faltan ' + (h.tabs - h.panels) + ')');
    if (h.panelsHidden) chap.notes.push(h.panelsHidden + ' panel(es) de pestañas ocultos con hidden/display:none');
    if (h.accordionsClosed) chap.notes.push(h.accordionsClosed + ' acordeón(es) colapsado(s) (contenido presente en el HTML, se abre con clic)');
    if (h.mbar) chap.warnings.push('carrusel mbar con ' + h.mbar + ' contenedor(es): comprobar que todas las diapositivas estén en el HTML');
    if (a.badFragmentRefs) chap.notes.push(a.badFragmentRefs + ' referencia(s) SVG url(#id) mal reescritas a URL absoluta (en el HTML)');
    // capítulo sospechoso: es un cuestionario (sobrescribió la sección real) o su título no corresponde al archivo
    const secOfFile = sectionOf(chap.id);
    if (a.title && QUIZ_TITLE_RE.test(a.title))
      chap.issues.push('capítulo sospechoso: el título es "' + a.title.slice(0, 50) + '" (un cuestionario), no la sección ' + (secOfFile || chap.id) + ': probablemente sobrescribió el contenido real; vuelva a descargarlo');
    const tnum = /\|\s*(\d+\.\d+)\.?\s/.exec(a.title || '');
    if (tnum && secOfFile && tnum[1] !== secOfFile)
      chap.warnings.push('capítulo sospechoso: el título dice ' + tnum[1] + ' pero el archivo es ' + chap.id + ' (¿colisión de ids?)');
    const fakeInChap = subtopicsOfHtml(html).filter((x) => bogusSubtopic(x.sub, x.title, secOfFile));
    if (fakeInChap.length) {
      chap.warnings.push('capítulo sospechoso: ' + fakeInChap.length + ' subtema(s) falso(s) en data-sub (' + fakeInChap.slice(0, 4).map((x) => x.sub + ' "' + x.title.slice(0, 14) + '"').join(', ') + ')');
      chap.fakeSubs = fakeInChap.map((x) => x.sub);
    }
    // vídeos: reproductor perezoso sin activar (solo póster) = no se puede reproducir offline
    const pendingVideos = Math.max(0, a.video.bigPlay - a.video.videos);
    chap.videos = { total: a.video.videos + pendingVideos, offline: a.video.offline, pending: pendingVideos, tracks: a.video.tracks };
    if (pendingVideos)
      chap.warnings.push(pendingVideos + ' vídeo(s) sin reproductor offline (solo póster + botón de play; no hay <video> ni fuente guardada). Vuelva a descargar este capítulo.');
    if (a.title && titles.has(a.title)) chap.warnings.push('mismo <title> que ' + titles.get(a.title));
    if (a.title) titles.set(a.title, chap.file);
    if (a.title && !/\|/.test(a.title)) chap.notes.push('título sin prefijo de módulo: "' + a.title.slice(0, 60) + '"');

    // referencias
    const missing = [];
    const remote = [];
    const remoteLinks = [];
    for (const r of a.refs) {
      const x = resolveLocal(full, r.url, courseDir);
      if (x.skip) continue;
      res.refs.checked++;
      if (x.remote) {
        let host = '';
        try {
          host = new URL(x.remote).hostname;
        } catch (e) {
          continue;
        }
        const isResource = r.kind !== 'a' || BIN_EXT.has(extOf(x.remote));
        if (r.kind === 'iframe' || isResource) {
          if (!IGNORE_HOST_RE.test(host)) {
            res.refs.remote++;
            remote.push(r.kind + ': ' + x.remote.slice(0, 110));
          }
        } else remoteLinks.push(x.remote);
        continue;
      }
      referenced.add(x.abs);
      let ex = checkedRefs.get(x.abs);
      if (ex === undefined) {
        ex = fs.existsSync(x.abs);
        checkedRefs.set(x.abs, ex);
      }
      if (!ex) {
        if (r.kind === 'link-icon' || /favicon\.ico$/i.test(r.url)) {
          chap.warnings.push('favicon no guardado (' + r.url + '), solo cosmético');
          continue;
        }
        res.refs.missing++;
        missing.push(r.kind + ': ' + r.url.slice(0, 110));
      }
    }
    if (missing.length) chap.issues.push(missing.length + ' referencia(s) local(es) rotas: ' + [...new Set(missing)].slice(0, 4).join(' | ') + (missing.length > 4 ? ' …' : ''));
    const isFont = (u) => /\.(woff2?|ttf|otf|eot)(\?|#|$)/i.test(u);
    const remoteFonts = remote.filter(isFont);
    // url(#id) de SVG reescrito por error a una URL absoluta: es un defecto del descargador
    // (clip-path/mask apuntan a internet), pero NO es un recurso que falte -> aviso, no grave
    const isBadFragment = (u) => /authoring-resources\/%23[\w-]+$/.test(u);
    const remoteFrag = remote.filter(isBadFragment);
    // imágenes de fondo de hojas de estilo (url() en CSS) que siguen remotas: suelen ser referencias
    // rotas del propio curso (el servidor responde 403/404) -> aviso; el resto (img, a, poster, script...) es grave
    const isCssRef = (u) => /^css: /.test(u);
    const remoteCss = remote.filter((u) => !isFont(u) && !isBadFragment(u) && isCssRef(u));
    const remoteOther = remote.filter((u) => !isFont(u) && !isBadFragment(u) && !isCssRef(u));
    if (remoteCss.length) chap.warnings.push(remoteCss.length + ' imagen(es)/recurso(s) de CSS aún remoto(s) (probable referencia rota del curso, 403/404 en el servidor): ' + [...new Set(remoteCss)].slice(0, 2).map((u) => u.slice(0, 110)).join(' | '));
    if (remoteFrag.length) chap.warnings.push(remoteFrag.length + ' referencia(s) SVG url(#id) (clip-path/mask) apuntan a internet en vez de al propio SVG: los iconos pueden verse sin recorte/máscara');
    if (remoteOther.length) chap.issues.push(remoteOther.length + ' recurso(s) aún remoto(s) (no es 100% offline): ' + [...new Set(remoteOther)].slice(0, 3).join(' | ') + (remoteOther.length > 3 ? ' …' : ''));
    if (remoteFonts.length) chap.warnings.push(remoteFonts.length + ' fuente(s) aún remota(s) (ciscoSansTT en CSS adoptado; sin internet se usa fuente de reemplazo): ' + [...new Set(remoteFonts)].slice(0, 2).join(' | ') + ' …');
    const absText = a.absoluteInText.filter((u) => !remote.some((r) => r.endsWith(u.slice(0, 110))));
    if (absText.length) chap.warnings.push(absText.length + ' URL(s) absoluta(s) a recursos dentro de datos/JSON del capítulo: ' + absText.slice(0, 2).map((u) => u.slice(0, 90)).join(' | '));
    if (remoteLinks.length) chap.notes.push(remoteLinks.length + ' enlace(s) externo(s) normales (<a>)');
    chap.remoteLinks = remoteLinks.length;
    res.chapters.push(chap);
  }

  // assets sin usar (solo informativo; las fuentes se citan desde hojas adoptadas)
  for (const [f] of assetFiles) if (!referenced.has(f)) res.assets.orphans.push(path.relative(courseDir, f));

  // --- resumen de problemas ---
  const badChapters = res.chapters.filter((c) => c.issues.length);
  res.badChapters = badChapters.length;
  for (const c of badChapters) P.graves.push(c.file + ': ' + c.issues.join('; '));
  for (const c of res.chapters) if (!c.issues.length && c.warnings.length) P.avisos.push(c.file + ': ' + c.warnings.join('; '));
  for (const c of res.chapters) if (c.issues.length && c.warnings.length) P.avisos.push(c.file + ' (además): ' + c.warnings.join('; '));
  if (res.assets.zero.length) P.graves.push(res.assets.zero.length + ' asset(s) vacío(s): ' + res.assets.zero.slice(0, 10).join(', '));
  for (const c of res.assets.corrupt) P.graves.push('Asset dañado ' + c.file + ': ' + c.problem);
  if (res.assets.duplicates.length) {
    let waste = 0;
    for (const g of res.assets.duplicates) waste += fs.statSync(path.join(courseDir, g[0])).size * (g.length - 1);
    res.assets.duplicateBytes = waste;
    P.info.push(res.assets.duplicates.length + ' grupo(s) de assets duplicados (mismo contenido), ' + human(waste) + ' desperdiciados');
  }
  if (res.assets.orphans.length) P.info.push(res.assets.orphans.length + ' asset(s) no referenciados desde ningún HTML/CSS');
  const totalNotes = res.chapters.reduce((n, c) => n + c.notes.length, 0);
  res.noteCount = totalNotes;
  return res;
}

// ───────────────────────── Comparación de carpetas gemelas ─────────────────────────
function compareTwins(courses) {
  const groups = new Map();
  for (const c of courses) {
    const key = c.name.split('_')[0];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const out = [];
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    const score = (c) => ({
      okChapters: c.chapters.filter((x) => !x.issues.length).length,
      chapters: c.totals.chapterFiles,
      assets: c.assets.total,
      graves: c.problems.graves.length,
      index: c.indexExists ? 1 : 0,
    });
    const sorted = [...list].sort((a, b) => {
      const sa = score(a);
      const sb = score(b);
      return sb.okChapters - sa.okChapters || sb.chapters - sa.chapters || sb.index - sa.index || sb.assets - sa.assets || sa.graves - sb.graves;
    });
    const [best, ...others] = sorted;
    const ids = (c) => new Set(c.chapters.map((x) => normChapter(x.id)));
    const entry = { key, best: best.name, details: [] };
    for (const o of others) {
      const bi = ids(best);
      const oi = ids(o);
      const onlyBest = [...bi].filter((x) => !oi.has(x)).sort(cmpChapter);
      const onlyOther = [...oi].filter((x) => !bi.has(x)).sort(cmpChapter);
      const better = [];
      for (const c of o.chapters) {
        const same = best.chapters.find((x) => normChapter(x.id) === normChapter(c.id));
        if (same && same.issues.length && !c.issues.length) better.push(normChapter(c.id));
      }
      entry.details.push({ other: o.name, onlyBest, onlyOther, betterInOther: better, scoreBest: score(best), scoreOther: score(o) });
    }
    out.push(entry);
  }
  return out;
}

// ───────────────────────── Informe ─────────────────────────
function bullet(list, max) {
  const l = list.slice(0, max).map((x) => '  - ' + x);
  if (list.length > max) l.push('  - … y ' + (list.length - max) + ' más (ver JSON con --json)');
  return l.join('\n');
}

function buildReport(results, twins, opt) {
  const L = [];
  const now = new Date();
  L.push('# Informe de validación de descargas (ccna-dl)');
  L.push('');
  L.push('- Fecha: ' + now.toLocaleString('es-PE', { timeZone: 'America/Lima' }) + ' (hora de Lima)');
  L.push('- Carpeta analizada: `' + opt.root + '`');
  L.push('- Umbrales: capítulo < ' + human(opt.minBytes) + ' o < ' + opt.minText + ' caracteres de texto se marcan como sospechosos.');
  L.push('- Esta validación es **offline**: no inicia sesión ni toca netacad.com, y no modifica los cursos.');
  L.push('');
  L.push('## Resumen general');
  L.push('');
  L.push('| Curso | Capítulos | Con problemas | Assets | Tamaño | Refs rotas | Refs remotas | Graves | Avisos |');
  L.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of results) {
    L.push(`| ${r.name.slice(0, 70)} | ${r.totals.chapterFiles} | ${r.badChapters} | ${r.assets.total} | ${human(r.assets.bytes + r.totals.chapterBytes)} | ${r.refs.missing} | ${r.refs.remote} | ${r.problems.graves.length} | ${r.problems.avisos.length} |`);
  }
  L.push('');
  for (const r of results) {
    L.push('## Curso: ' + r.name);
    L.push('');
    L.push(`- Índice (index.html): ${r.indexExists ? 'sí' : '**NO existe**'}`);
    L.push(`- Módulos detectados: ${r.modules && r.modules.length ? r.modules.join(', ') : 'ninguno'}`);
    L.push(`- Capítulos en disco: ${r.totals.chapterFiles} (${human(r.totals.chapterBytes)}); sin problemas: ${r.totals.chapterFiles - r.badChapters}; con problemas graves: ${r.badChapters}`);
    L.push(`- Assets: ${r.assets.total} archivos (${human(r.assets.bytes)}); vacíos: ${r.assets.zero.length}; dañados: ${r.assets.corrupt.length}; grupos duplicados: ${r.assets.duplicates.length}; sin referenciar: ${r.assets.orphans.length}`);
    L.push(`- Referencias locales comprobadas: ${r.refs.checked}; rotas: ${r.refs.missing}; remotas (no offline): ${r.refs.remote}`);
    L.push('');
    // resumen por categoría: cuántos capítulos tienen cada tipo de problema
    const cats = new Map();
    const catKey = (m) =>
      m
        .replace(/https?:\/\/\S+/g, '')
        .replace(/:.*$/, '')
        .replace(/\d+/g, 'N')
        .trim()
        .slice(0, 120);
    for (const c of r.chapters) {
      for (const [sev, arr] of [['GRAVE', c.issues], ['aviso', c.warnings]]) {
        for (const m of arr || []) {
          const k = sev + '|' + catKey(m);
          if (!cats.has(k)) cats.set(k, []);
          cats.get(k).push(c.id);
        }
      }
    }
    if (cats.size) {
      L.push('### Resumen por categoría (capítulos afectados)');
      L.push('');
      L.push('| Gravedad | Problema | Capítulos |');
      L.push('|---|---|---:|');
      for (const [k, ids] of [...cats.entries()].sort((a, b) => (a[0][0] === b[0][0] ? b[1].length - a[1].length : a[0][0] === 'G' ? -1 : 1))) {
        const [sev, txt] = k.split('|');
        L.push(`| ${sev} | ${txt} | ${new Set(ids).size} |`);
      }
      L.push('');
    }
    L.push(`### Problemas graves (${r.problems.graves.length})`);
    L.push(r.problems.graves.length ? bullet(r.problems.graves, 40) : '- Ninguno ✅');
    L.push('');
    L.push(`### Avisos (${r.problems.avisos.length})`);
    L.push(r.problems.avisos.length ? bullet(r.problems.avisos, 40) : '- Ninguno ✅');
    L.push('');
    if (r.problems.info.length) {
      L.push('### Información');
      L.push(bullet(r.problems.info, 20));
      L.push('');
    }
    const notes = r.chapters.filter((c) => c.notes.length);
    if (notes.length) {
      L.push(`<details><summary>Notas por capítulo (${notes.length})</summary>`);
      L.push('');
      L.push(bullet(notes.map((c) => c.file + ': ' + c.notes.join('; ')), 60));
      L.push('');
      L.push('</details>');
      L.push('');
    }
  }
  if (twins.length) {
    L.push('## Comparación de carpetas del mismo curso');
    L.push('');
    for (const t of twins) {
      L.push(`### ${t.key}`);
      L.push(`**Más completa: \`${t.best}\`**`);
      for (const d of t.details) {
        const sb = d.scoreBest;
        const so = d.scoreOther;
        L.push('');
        L.push(`- Comparada con \`${d.other}\`:`);
        L.push(`  - Capítulos sin problemas: ${sb.okChapters} vs ${so.okChapters}; capítulos en disco: ${sb.chapters} vs ${so.chapters}; assets: ${sb.assets} vs ${so.assets}; índice: ${sb.index ? 'sí' : 'no'} vs ${so.index ? 'sí' : 'no'}`);
        L.push(`  - Capítulos que solo están en la más completa (${d.onlyBest.length}): ${d.onlyBest.slice(0, 40).join(', ') || '—'}${d.onlyBest.length > 40 ? ' …' : ''}`);
        L.push(`  - Capítulos que solo están en la otra (${d.onlyOther.length}): ${d.onlyOther.slice(0, 40).join(', ') || '—'}`);
        L.push(`  - Capítulos con problemas en la más completa pero sanos en la otra (${d.betterInOther.length}): ${d.betterInOther.join(', ') || '—'}`);
      }
      L.push('');
    }
  }
  L.push('---');
  L.push('Cómo repetirlo: `npm run validate` (o `node scripts/validate-download.js --help`).');
  return L.join('\n') + '\n';
}

// ───────────────────────── Principal ─────────────────────────
function main() {
  const opt = parseArgs(process.argv.slice(2));
  let dirs = findCourses(opt.root);
  if (opt.course) dirs = dirs.filter((d) => path.basename(d).toLowerCase().includes(opt.course.toLowerCase()));
  if (!dirs.length) {
    console.error('No se encontraron carpetas de curso en ' + opt.root);
    process.exit(2);
  }
  const results = [];
  for (const d of dirs) {
    if (!opt.quiet) console.error('Validando ' + path.basename(d) + ' …');
    results.push(validateCourse(d, opt));
  }
  const twins = compareTwins(results);
  const md = buildReport(results, twins, opt);
  fs.writeFileSync(opt.out, md, 'utf8');
  if (opt.json) {
    fs.writeFileSync(opt.json, JSON.stringify({ generated: new Date().toISOString(), results, twins }, null, 2), 'utf8');
  }
  if (!opt.quiet) {
    console.log(md.split('## Curso:')[0]);
    console.log('Informe guardado en: ' + opt.out);
  }
  process.exit(results.some((r) => r.problems.graves.length) ? 1 : 0);
}

if (require.main === module) main();
module.exports = { analyzeHtml, validateCourse, cssRefs, resolveLocal, compareTwins, bogusSubtopic, subtopicsOfHtml, sectionOf, sniffProblem };
