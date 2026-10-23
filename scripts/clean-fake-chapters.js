#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
/**
 * Limpia, SIN volver a descargar nada, lo que las versiones anteriores de ccna-dl dejaron mal en cursos ya
 * descargados (HTML):
 *
 *  1. Subtemas falsos en el índice (index.html) y en los capítulos (data-sub): las IPs/redes del texto
 *     ("10.1.0.0/16", "172.16.5.0/24", "2.2.2.2") se tomaban por "subtemas" ("10.1.0", título ".0/16").
 *  2. Capítulos sobrescritos por un cuestionario: "2.2.1 Prueba de mi conocimiento" se guardaba como
 *     chapters/2.2.html y pisaba el contenido real de la sección 2.2. El archivo se aparta (copia en la
 *     carpeta de respaldo) para que la siguiente ejecución lo vuelva a descargar.
 *  3. Entradas duplicadas en descarga-resumen.json (mismo capítulo dos veces).
 *
 * Por defecto NO modifica nada (--dry-run): solo muestra qué haría. Con --apply actúa, y antes copia todo lo
 * que toca a <curso>/.limpieza-AAAAMMDD-HHMMSS/ (carpeta oculta que el validador ignora).
 *
 * Uso:
 *   node scripts/clean-fake-chapters.js                       # simulación sobre los cursos de la carpeta del proyecto
 *   node scripts/clean-fake-chapters.js --apply               # aplica
 *   node scripts/clean-fake-chapters.js --root D:\cursos      # otra carpeta raíz
 *   node scripts/clean-fake-chapters.js --course OSPF         # solo cursos cuyo nombre contenga "OSPF"
 *   node scripts/clean-fake-chapters.js --dir "C:\ruta\curso" # una carpeta de curso concreta
 *
 * Después: `npm run build` y vuelve a ejecutar la misma descarga con reanudación (sin --force): solo se
 * repiten los capítulos que faltan (p. ej. 2.2) y los que tienen vídeos sin activar.
 * Solo requiere Node >= 16. No usa red ni login.
 */
const fs = require('fs');
const path = require('path');
const { bogusSubtopic, subtopicsOfHtml, sectionOf } = require('./validate-download');

const QUIZ_TITLE_RE = /^\s*(prueba de mi conocimiento|prueba de conocimiento|knowledge check|comprueba tu conocimiento|mon contr[oô]le)/i;
const SKIP_DIRS = new Set(['node_modules', 'lib', 'src', 'scripts', 'test', '.git', 'dist']);

function parseArgs(argv) {
  const o = { root: path.resolve(__dirname, '..'), course: null, dir: null, apply: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') o.apply = true;
    else if (a === '--dry-run') o.apply = false;
    else if (a === '--root') o.root = path.resolve(argv[++i]);
    else if (a === '--course') o.course = argv[++i];
    else if (a === '--dir') o.dir = path.resolve(argv[++i]);
    else if (a === '-h' || a === '--help') o.help = true;
    else {
      console.error('Opción desconocida: ' + a);
      process.exit(2);
    }
  }
  return o;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function isCourseDir(dir) {
  return fs.existsSync(path.join(dir, 'chapters')) || (fs.existsSync(path.join(dir, 'assets')) && fs.existsSync(path.join(dir, 'index.html')));
}

function findCourses(root) {
  let ents = [];
  try {
    ents = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return ents
    .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'))
    .map((e) => path.join(root, e.name))
    .filter(isCourseDir)
    .sort();
}

const INDEX_SUB_RE = /<li class="sub"><a href="([^"#]*)#sub-([^"]+)"[^>]*><span class="num">([^<]*)<\/span> <span class="t">([^<]*)<\/span><\/a><\/li>\r?\n?/g;

/** Quita del índice los subtemas falsos. Devuelve el HTML nuevo y la lista de los quitados. */
function cleanIndexHtml(html) {
  const removed = [];
  let out = html.replace(INDEX_SUB_RE, (whole, href, sub, num, title) => {
    const id = path.basename(href).replace(/\.html$/i, '');
    const why = bogusSubtopic(decodeEntities(sub), decodeEntities(title), sectionOf(id));
    if (!why) return whole;
    removed.push({ file: href, sub: decodeEntities(sub), title: decodeEntities(title), why });
    return '';
  });
  // listas de subtemas que se quedaron vacías
  out = out.replace(/<ul class="subs">\s*<\/ul>/g, '');
  return { html: out, removed };
}

/** Quita de un capítulo los atributos data-sub falsos. */
function cleanChapterHtml(html, section) {
  const removed = [];
  const fake = new Set();
  for (const s of subtopicsOfHtml(html)) {
    const why = bogusSubtopic(s.sub, s.title, section);
    if (why) {
      fake.add(s.sub);
      removed.push({ sub: s.sub, title: s.title, why });
    }
  }
  if (!fake.size) return { html, removed };
  const out = html.replace(/\sdata-sub="(\d+(?:\.\d+)*)"/g, (whole, sub) => (fake.has(sub) ? '' : whole));
  return { html: out, removed };
}

function titleOf(html) {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  return m ? decodeEntities(m[1]).trim() : '';
}

function chapterParamOf(url) {
  const m = /[?&]_chapter=([\d.]+)/.exec(url || '');
  return m ? m[1] : '';
}

/** Quita entradas duplicadas del resumen: de un mismo id se descarta la que vino de X.Y.1 si existe X.Y. */
function cleanSummary(summary) {
  if (!summary || !Array.isArray(summary.chapters)) return { summary, removed: [] };
  const byId = new Map();
  for (const c of summary.chapters) {
    if (!byId.has(c.chapter)) byId.set(c.chapter, []);
    byId.get(c.chapter).push(c);
  }
  const drop = new Set();
  for (const list of byId.values()) {
    if (list.length < 2) continue;
    const keep = list.find((c) => !/\.1$/.test(chapterParamOf(c.url))) || list[0];
    for (const c of list) if (c !== keep) drop.add(c);
  }
  if (!drop.size) return { summary, removed: [] };
  const chapters = summary.chapters.filter((c) => !drop.has(c));
  const totals = { ...(summary.totals || {}) };
  totals.total = chapters.length;
  for (const k of ['guardado', 'omitido', 'parcial', 'fallido']) totals[k] = chapters.filter((c) => c.status === k).length;
  return {
    summary: { ...summary, chapters, totals },
    removed: [...drop].map((c) => ({ chapter: c.chapter, url: c.url })),
  };
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Analiza (y, con apply, corrige) un curso. Devuelve el plan/resultado.
 */
function cleanCourse(courseDir, { apply }) {
  const plan = { dir: courseDir, index: { removed: [] }, chapters: [], quizzes: [], summary: { removed: [] }, backupDir: null, changed: false };
  const writes = []; // {file, content}
  const moves = []; // {file}

  const indexFile = path.join(courseDir, 'index.html');
  if (fs.existsSync(indexFile)) {
    const r = cleanIndexHtml(fs.readFileSync(indexFile, 'utf8'));
    plan.index.removed = r.removed;
    if (r.removed.length) writes.push({ file: indexFile, content: r.html });
  }

  const chaptersDir = path.join(courseDir, 'chapters');
  let files = [];
  try {
    files = fs.readdirSync(chaptersDir).filter((f) => /\.html$/i.test(f) && !f.startsWith('.'));
  } catch {
    // sin capítulos
  }
  const summaryFile = path.join(courseDir, 'descarga-resumen.json');
  let summary = null;
  try {
    summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
  } catch {
    // sin resumen
  }
  const dupIds = new Set();
  if (summary && Array.isArray(summary.chapters)) {
    const seen = new Set();
    for (const c of summary.chapters) {
      if (seen.has(c.chapter)) dupIds.add(c.chapter);
      seen.add(c.chapter);
    }
  }

  for (const f of files) {
    const id = f.replace(/\.html$/i, '');
    const full = path.join(chaptersDir, f);
    const html = fs.readFileSync(full, 'utf8');
    const title = titleOf(html);
    if (QUIZ_TITLE_RE.test(title)) {
      plan.quizzes.push({ file: path.join('chapters', f), title, duplicated: dupIds.has(id) });
      moves.push({ file: full });
      continue; // se aparta entero: no tiene sentido limpiarlo
    }
    const r = cleanChapterHtml(html, sectionOf(id));
    if (r.removed.length) {
      plan.chapters.push({ file: path.join('chapters', f), removed: r.removed });
      writes.push({ file: full, content: r.html });
    }
  }

  if (summary) {
    const r = cleanSummary(summary);
    plan.summary.removed = r.removed;
    if (r.removed.length) writes.push({ file: summaryFile, content: JSON.stringify(r.summary, null, 2) + '\n' });
  }

  plan.changed = writes.length > 0 || moves.length > 0;
  if (apply && plan.changed) {
    const backup = path.join(courseDir, '.limpieza-' + stamp());
    plan.backupDir = backup;
    const keep = (file) => {
      const dest = path.join(backup, path.relative(courseDir, file));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(file, dest);
    };
    for (const w of writes) keep(w.file);
    for (const m of moves) keep(m.file);
    for (const w of writes) {
      const tmp = w.file + '.limpieza.part';
      fs.writeFileSync(tmp, w.content, 'utf8');
      fs.renameSync(tmp, w.file);
    }
    for (const m of moves) fs.rmSync(m.file); // ya está copiado en la carpeta de respaldo
  }
  return plan;
}

function report(plan, apply) {
  const rel = (p) => p.replace(/\\/g, '/');
  console.log('\n== ' + path.basename(plan.dir));
  if (!plan.changed) {
    console.log('   Nada que limpiar.');
    return;
  }
  const verb = apply ? 'Quitados' : 'Se quitarían';
  if (plan.index.removed.length) {
    console.log(`   · index.html: ${verb} ${plan.index.removed.length} subtema(s) falso(s) del índice. Ejemplos:`);
    for (const r of plan.index.removed.slice(0, 5)) console.log(`       ${rel(r.file)} #${r.sub} "${r.title}" (${r.why})`);
  }
  if (plan.chapters.length) {
    const n = plan.chapters.reduce((a, c) => a + c.removed.length, 0);
    console.log(`   · ${verb} ${n} data-sub falso(s) en ${plan.chapters.length} capítulo(s):`);
    for (const c of plan.chapters.slice(0, 8)) console.log(`       ${rel(c.file)}: ${c.removed.map((x) => x.sub).join(', ')}`);
  }
  for (const q of plan.quizzes) {
    console.log(
      `   · ${apply ? 'Apartado' : 'Se apartaría'} ${rel(q.file)}: su título es un cuestionario ("${q.title.slice(0, 50)}"${q.duplicated ? ', capítulo duplicado en el resumen' : ''}); ` +
        'el contenido real de la sección se vuelve a descargar en la próxima ejecución.'
    );
  }
  if (plan.summary.removed.length) {
    console.log(`   · descarga-resumen.json: ${verb} ${plan.summary.removed.length} entrada(s) duplicada(s) (${plan.summary.removed.map((r) => r.chapter).join(', ')}).`);
  }
  if (apply && plan.backupDir) console.log('   Copia de lo modificado en: ' + plan.backupDir);
}

function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^[\s\S]*?\/\*\*\n/, '').replace(/^ \* ?/gm, ''));
    return;
  }
  let dirs = opt.dir ? [opt.dir] : findCourses(opt.root);
  if (opt.course) dirs = dirs.filter((d) => path.basename(d).toLowerCase().includes(opt.course.toLowerCase()));
  if (!dirs.length) {
    console.error('No se encontró ningún curso descargado en ' + (opt.dir || opt.root));
    process.exit(2);
  }
  console.log(opt.apply ? 'MODO APLICAR: se modificarán los cursos (con copia de respaldo).' : 'SIMULACIÓN (--dry-run): no se modifica nada. Usa --apply para aplicar.');
  let changed = 0;
  for (const d of dirs) {
    const plan = cleanCourse(d, { apply: opt.apply });
    report(plan, opt.apply);
    if (plan.changed) changed++;
  }
  console.log(`\n${changed} de ${dirs.length} curso(s) ${opt.apply ? 'limpiados' : 'necesitan limpieza'}.`);
  if (changed) {
    console.log(
      opt.apply
        ? 'Siguiente: npm run build y vuelve a lanzar la descarga con reanudación (sin --force) para recuperar los capítulos apartados y los vídeos.'
        : 'Para aplicar: node scripts/clean-fake-chapters.js --apply'
    );
  }
}

if (require.main === module) main();
module.exports = { cleanIndexHtml, cleanChapterHtml, cleanSummary, cleanCourse, titleOf };
