'use strict';
// Capítulos/subtemas inexistentes: IPs del texto tomadas por subtemas y cuestionarios que pisan secciones.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isBogusSubtopicTitle, isPlausibleSubtopic, filterPlausibleSubtopics, sectionOfChapter, normalizeSubtopicTitle } = require('../lib/subtopics');
const { dropShadowedSubchapters, dedupeByFileId, fileChapterId } = require('../lib/chapter-ids');
const { parseSubtopicsFromSavedHtml, buildIndexHtml } = require('../lib/save-chapter-html');
const { bogusSubtopic, subtopicsOfHtml, sectionOf } = require('../scripts/validate-download');
const { cleanIndexHtml, cleanChapterHtml, cleanSummary, cleanCourse } = require('../scripts/clean-fake-chapters');

const sub = (s, t) => ({ sub: s, title: t });

test('subtemas: las IPs/redes del texto no son subtemas', () => {
  // casos reales del curso OSPF
  assert.ok(isBogusSubtopicTitle('.0/16'));
  assert.ok(isBogusSubtopicTitle('.0/24'));
  assert.ok(isBogusSubtopicTitle('.2'));
  assert.ok(isBogusSubtopicTitle('0/16'));
  assert.ok(isBogusSubtopicTitle('.1 ????'), 'resto de una IP');
  assert.ok(!isBogusSubtopicTitle('. Ataques DNS'), 'título real guardado con el punto del número');
  assert.ok(isBogusSubtopicTitle(''));
  assert.ok(!isPlausibleSubtopic(sub('10.1.0', '.0/16')));
  assert.ok(!isPlausibleSubtopic(sub('172.16.5', 'red de la sucursal'), '1.3'), 'no pertenece a la sección 1.3');
  assert.ok(!isPlausibleSubtopic(sub('2.2.2', 'router'), '2.3'), '2.2.2 no es de la sección 2.3');
  assert.ok(!isPlausibleSubtopic(sub('192.16810.10', 'PC2')), 'octeto de 5 dígitos');
  assert.ok(!isPlausibleSubtopic(sub('1.3', 'dos grupos')));
  // reales
  assert.ok(isPlausibleSubtopic(sub('1.3.1', 'Vídeo - Conceptos de OSPF'), '1.3'));
  assert.ok(isPlausibleSubtopic(sub('1.1.1', 'Título con número 5'), '1.1'));
  assert.ok(isPlausibleSubtopic(sub('10.1.1', 'Módulo décimo'), '10.1'));
  assert.ok(isPlausibleSubtopic(sub('1.3.1', '¿Por qué?')));
  const mixed = [sub('1.3.1', 'Real'), sub('10.1.0', '.0/16'), sub('172.16.5', 'red'), sub('1.3.2', 'Otro')];
  assert.deepEqual(filterPlausibleSubtopics(mixed, '1.3').map((s) => s.sub), ['1.3.1', '1.3.2']);
});

test('normalizeSubtopicTitle y títulos reales con basura delante', () => {
  assert.equal(normalizeSubtopicTitle('. Ataques DNS'), 'Ataques DNS');
  assert.equal(normalizeSubtopicTitle('.0/16'), '.0/16');
  assert.deepEqual(filterPlausibleSubtopics([sub('4.1.3', '. Ataques DNS')], '4.1'), [sub('4.1.3', 'Ataques DNS')]);
  // el primer encabezado del bloque es basura (un carácter sin letras): se usa el siguiente con texto
  const html = '<div data-sub="13.1.13"><h1>\u00a0</h1><h1><span>13.1.13 Vídeo de Packet Tracer</span></h1></div>';
  assert.deepEqual(parseSubtopicsFromSavedHtml(html, '13').map((s) => s.sub), ['13.1.13']);
  assert.deepEqual(subtopicsOfHtml(html).map((s) => bogusSubtopic(s.sub, s.title, '13.1')), [null]);
});

test('sectionOfChapter: id de archivo -> sección', () => {
  assert.equal(sectionOfChapter('1.3'), '1.3');
  assert.equal(sectionOfChapter('1'), '1.1');
  assert.equal(sectionOfChapter('2.2.1'), undefined);
});

test('ids de capítulo: X.Y.1 se descarta si existe X.Y (el cuestionario 2.2.1 no pisa la sección 2.2)', () => {
  const e = (chapter) => ({ chapter });
  const r = dropShadowedSubchapters([e('2.1'), e('2.2'), e('2.2.1'), e('2.3'), e('3.1.1')]);
  assert.deepEqual(r.kept.map((x) => x.chapter), ['2.1', '2.2', '2.3', '3.1.1'], 'el X.Y.1 sin X.Y (formato antiguo) se conserva');
  assert.deepEqual(r.dropped.map((x) => x.chapter), ['2.2.1']);
  assert.equal(fileChapterId('1.1'), '1', 'X.1 -> X (nombrado de archivo)');
  assert.equal(fileChapterId('1.2'), '1.2');
  assert.equal(fileChapterId('2.2.1'), '2.2');
});

test('dedupeByFileId: un solo URL por archivo, gana la sección real', () => {
  const chapterOf = (u) => u.split('=').pop();
  const urls = ['u=2.2', 'u=2.3', 'u=2.2.1'];
  const a = dedupeByFileId(urls, chapterOf);
  assert.deepEqual(a.urls, ['u=2.2', 'u=2.3']);
  assert.equal(a.dropped.length, 1);
  assert.equal(a.dropped[0].chapter, '2.2.1');
  assert.equal(a.dropped[0].keptChapter, '2.2');
  // el orden inverso: gana igualmente 2.2
  const b = dedupeByFileId(['u=2.2.1', 'u=2.2'], chapterOf);
  assert.deepEqual(b.urls, ['u=2.2']);
  assert.equal(b.dropped[0].chapter, '2.2.1');
  // sin colisión no se toca nada
  assert.deepEqual(dedupeByFileId(['u=1.1', 'u=1.2'], chapterOf).urls, ['u=1.1', 'u=1.2']);
});

test('parseSubtopicsFromSavedHtml filtra los data-sub falsos de un capítulo guardado', () => {
  const html =
    '<div data-sub="2.3.1"><h2 class="headingtitle">Configuración de OSPF</h2></div>' +
    '<g data-sub="172.16.2"><text>172.16.2</text></g><div data-sub="2.2.2"><h3>Red 2.2.2</h3></div>' +
    '<div data-sub="2.3.2"><h2 class="headingtitle">Verificación</h2></div>';
  assert.deepEqual(parseSubtopicsFromSavedHtml(html, '2.3').map((s) => s.sub), ['2.3.1', '2.3.2']);
  // sin id de capítulo no se conoce la sección: los reales se conservan y los de título imposible se descartan
  const noSection = parseSubtopicsFromSavedHtml('<div data-sub="1.3.1"><h2 class="headingtitle">Real</h2></div><g data-sub="10.1.0"><text>.0/16</text></g>');
  assert.ok(noSection.some((s) => s.sub === '1.3.1'));
});

test('buildIndexHtml: no pinta subtemas falsos aunque lleguen en las entradas', () => {
  const html = buildIndexHtml('Curso', [
    { chapter: '1.3', title: 'T', file: 'chapters/1.3.html', subtopics: [sub('1.3.1', 'Real'), sub('10.1.0', '.0/16'), sub('172.16.5', 'red')] },
  ]);
  assert.equal((html.match(/<li class="sub">/g) || []).length, 1);
  assert.match(html, /#sub-1\.3\.1/);
  assert.ok(!/172\.16\.5|10\.1\.0/.test(html));
});

test('validador: bogusSubtopic y subtopicsOfHtml (sin falsos positivos del script cargador)', () => {
  assert.ok(bogusSubtopic('10.1.0', '.0/16', '1.0'));
  assert.ok(bogusSubtopic('172.16.5', 'x', '1.3'));
  assert.equal(bogusSubtopic('1.3.1', 'Real', '1.3'), null);
  assert.equal(sectionOf('1'), '1.1');
  const html = '<h2 data-sub="1.3.1">A</h2><script>roots[i].querySelector(\'[data-sub="\' + num + \'"]\')</script>';
  assert.deepEqual(subtopicsOfHtml(html).map((s) => s.sub), ['1.3.1']);
});

const idxLi = (file, sub, title) => `<li class="sub"><a href="${file}#sub-${sub}" target="content" data-file="${file}"><span class="num">${sub}</span> <span class="t">${title}</span></a></li>\n`;

test('limpieza: cleanIndexHtml / cleanChapterHtml / cleanSummary', () => {
  const idx =
    '<li class="chap"><a href="chapters/1.html">x</a><ul class="subs">\n' +
    idxLi('chapters/1.html', '1.1.1', 'Real') +
    idxLi('chapters/1.html', '10.1.0', '.0/16') +
    '</ul></li>\n<li class="chap"><a href="chapters/2.html">y</a><ul class="subs">\n' +
    idxLi('chapters/2.html', '172.16.5', '.0/24') +
    '</ul></li>';
  const r = cleanIndexHtml(idx);
  assert.equal(r.removed.length, 2);
  assert.equal((r.html.match(/<li class="sub">/g) || []).length, 1);
  assert.ok(!/<ul class="subs">\s*<\/ul>/.test(r.html), 'sin listas vacías');
  assert.equal(cleanIndexHtml(r.html).removed.length, 0, 'idempotente');
  const rep = cleanIndexHtml(idxLi('chapters/4.html', '4.1.3', '. Ataques DNS'));
  assert.equal(rep.removed.length, 0, 'un título real con el punto del número no se borra');
  assert.equal(rep.repaired.length, 1);
  assert.match(rep.html, /<span class="t">Ataques DNS<\/span>/);

  const ch = cleanChapterHtml('<h2 data-sub="2.3.1">Real</h2><p data-sub="172.16.1">172.16.1</p><x data-sub="2.2.2">z</x>', '2.3');
  assert.deepEqual(ch.removed.map((x) => x.sub).sort(), ['172.16.1', '2.2.2']);
  assert.match(ch.html, /data-sub="2\.3\.1"/);
  assert.ok(!/data-sub="(172|2\.2\.2)/.test(ch.html));

  const s = cleanSummary({
    totals: { total: 3, guardado: 3 },
    chapters: [
      { chapter: '2.2', url: 'https://x/launch?_chapter=2.2', status: 'guardado' },
      { chapter: '2.2', url: 'https://x/launch?_chapter=2.2.1', status: 'guardado' },
      { chapter: '2.3', url: 'https://x/launch?_chapter=2.3', status: 'guardado' },
    ],
  });
  assert.equal(s.removed.length, 1);
  assert.equal(s.summary.chapters.length, 2);
  assert.equal(s.summary.totals.total, 2);
  assert.match(s.summary.chapters[0].url, /_chapter=2\.2$/);
});

test('limpieza de un curso: simulación no toca nada; --apply respalda, limpia y aparta el cuestionario', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccna-clean-'));
  try {
    const course = path.join(dir, 'curso');
    fs.mkdirSync(path.join(course, 'chapters'), { recursive: true });
    const page = (title, body) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
    fs.writeFileSync(path.join(course, 'chapters', '2.3.html'), page('Config | Mod', '<h2 data-sub="2.3.1">Real</h2><p data-sub="172.16.1">x</p>'));
    fs.writeFileSync(path.join(course, 'chapters', '2.2.html'), page('Prueba de mi conocimiento | Mon contrôle des connaissances', '<p>quiz</p>'));
    fs.writeFileSync(path.join(course, 'chapters', '1.html'), page('Intro | Mod', '<h2 data-sub="1.1.1">Bien</h2>'));
    fs.writeFileSync(
      path.join(course, 'index.html'),
      '<ul class="subs">\n' + idxLi('chapters/2.3.html', '2.3.1', 'Real') + idxLi('chapters/2.3.html', '10.1.0', '.0/16') + '</ul>'
    );
    fs.writeFileSync(
      path.join(course, 'descarga-resumen.json'),
      JSON.stringify({ totals: { total: 2 }, chapters: [{ chapter: '2.2', url: 'u?_chapter=2.2', status: 'guardado' }, { chapter: '2.2', url: 'u?_chapter=2.2.1', status: 'guardado' }] })
    );
    const snap = () => fs.readdirSync(path.join(course, 'chapters')).map((f) => f + fs.readFileSync(path.join(course, 'chapters', f), 'utf8')).join('|') + fs.readFileSync(path.join(course, 'index.html'), 'utf8');
    const before = snap();

    const dry = cleanCourse(course, { apply: false });
    assert.ok(dry.changed);
    assert.equal(dry.index.removed.length, 1);
    assert.equal(dry.quizzes.length, 1);
    assert.equal(snap(), before, 'la simulación no modifica nada');
    assert.ok(!fs.readdirSync(course).some((f) => f.startsWith('.limpieza')));

    const done = cleanCourse(course, { apply: true });
    assert.ok(done.backupDir && fs.existsSync(path.join(done.backupDir, 'chapters', '2.2.html')), 'respaldo del cuestionario');
    assert.ok(fs.existsSync(path.join(done.backupDir, 'index.html')));
    assert.ok(!fs.existsSync(path.join(course, 'chapters', '2.2.html')), 'apartado para que se vuelva a descargar');
    assert.ok(fs.existsSync(path.join(course, 'chapters', '1.html')), 'los demás no se tocan');
    assert.ok(!/172\.16\.1/.test(fs.readFileSync(path.join(course, 'chapters', '2.3.html'), 'utf8')));
    assert.equal((fs.readFileSync(path.join(course, 'index.html'), 'utf8').match(/<li class="sub">/g) || []).length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(course, 'descarga-resumen.json'), 'utf8')).chapters.length, 1);
    assert.equal(cleanCourse(course, { apply: false }).changed, false, 'idempotente');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
