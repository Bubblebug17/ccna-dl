const test = require('node:test');
const assert = require('node:assert');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const h = require('../lib/save-chapter-html');

const chapterHtml = (title, subs) =>
  `<!DOCTYPE html><html><head><title>${title}</title></head><body>` +
  subs.map(([n, t]) => `<div data-sub="${n}"><div class="article__title"><heading-view headingtitle="${n} ${t}"><template shadowrootmode="open">${'x'.repeat(9000)}<h1>\u00a0</h1></template></heading-view></div></div>`).join('') +
  `</body></html>`;

test('títulos de subtemas desde headingtitle (aunque esté lejos o tras basura)', () => {
  const subs = h.parseSubtopicsFromSavedHtml(chapterHtml('M | 1.2. X', [['1.2.1', 'Uno &amp; dos'], ['1.2.2', 'Dos']]), '1.2');
  assert.deepStrictEqual(subs.map((s) => s.title), ['Uno & dos', 'Dos']);
});

test('cleanTitle y número de sección', () => {
  assert.strictEqual(h.cleanTitle('Módulo 1: OSPF | 1.3. Funcionamiento de OSPF'), 'Funcionamiento de OSPF');
  assert.strictEqual(h.cleanTitle('2.1. Router ID de OSPF', '2.1'), 'Router ID de OSPF');
  assert.strictEqual(h.cleanTitle('2.10 Algo'), 'Algo');
  assert.strictEqual(h.displayChapterNumber('2'), '2.1');
  assert.strictEqual(h.displayChapterNumber('2.10'), '2.10');
  assert.ok(h.isPlaceholderTitle('Subtema 1.2.1'));
});

test('un reintento no cambia títulos reales por "Subtema …" y el índice se repara', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'idx-'));
  mkdirSync(join(dir, 'chapters'));
  // capítulo cuyo HTML no tiene títulos legibles: solo el index.html anterior los conoce
  writeFileSync(join(dir, 'chapters', '2.html'), `<title>M | 2.1. Router ID de OSPF</title><div data-sub="2.1.1"></div><div data-sub="2.1.2"></div>`);
  writeFileSync(join(dir, 'chapters', '1.3.html'), chapterHtml('M | 1.3. Funcionamiento de OSPF', [['1.3.1', 'Paquetes OSPF']]));
  const old = h.buildIndexHtml('Curso', [{ chapter: '2', title: '2.1. Router ID de OSPF', file: 'chapters/2.html', subtopics: [{ sub: '2.1.1', title: 'Router ID' }, { sub: '2.1.2', title: 'Elección' }] }]);
  writeFileSync(join(dir, 'index.html'), old);
  const n = await h.rebuildCourseIndex(dir);
  assert.strictEqual(n, 2);
  const out = readFileSync(join(dir, 'index.html'), 'utf8');
  assert.ok(!/Subtema/.test(out), out);
  assert.match(out, /<span class="num">2\.1<\/span> <span class="t">Router ID de OSPF<\/span>/);
  assert.match(out, /<span class="num">1\.3<\/span> <span class="t">Funcionamiento de OSPF<\/span>/);
  assert.match(out, /Paquetes OSPF/);
  assert.match(out, /<title>Curso<\/title>/);
  // idempotente
  await h.rebuildCourseIndex(dir);
  assert.strictEqual(readFileSync(join(dir, 'index.html'), 'utf8'), out);
});
