'use strict';
// Interfaz de terminal: avisos cortos, etiquetas [INFO]/[WARN]/[ERROR]/[OK], ajuste al ancho, orden de capítulos.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { shortWarnings, isFontUrl, shortError } = require('../lib/warnings');
const { formatLine, setLogFile, log, setVerbosity } = require('../lib/ui/log');
const { fitAnsi, visLen, wrap, stripAnsi } = require('../lib/ui/text');
const { cmpIds, moduleOf } = require('../lib/progress');

test('avisos cortos: sin URLs y agrupados por tipo', () => {
  const s = shortWarnings([
    '14 recurso(s) no existen en el servidor (404/403…): https://a/b.png | https://a/c.png',
    '1 de 3 vídeo(s) sin reproductor offline: https://x/v.mp4',
    '1 de 3 vídeo(s) sin reproductor offline: https://x/v.mp4',
    '2 animación(es) sin recursos locales (https://x/anim)',
  ]);
  assert.deepStrictEqual(s, ['1 vídeo sin reproductor offline', '2 animaciones sin grabar']);
  assert.ok(s.every((w) => !/https?:/.test(w)));
});

test('fuentes del curso se reconocen (aviso único)', () => {
  assert.ok(isFontUrl('https://x/fonts/ciscoSansTT-Regular.woff2'));
  assert.ok(isFontUrl('https://x/a/CiscoSans.ttf?v=2'));
  assert.ok(!isFontUrl('https://x/img/topologia.png'));
  assert.strictEqual(shortError('Navigation timeout of 60000 ms exceeded; at x\nstack'), 'Navigation timeout of 60000 ms exceeded');
});

test('etiquetas y líneas que no pasan del ancho', () => {
  for (const [k, tag] of [['info', '[INFO]'], ['warn', '[WARN]'], ['error', '[ERROR]'], ['ok', '[OK]']]) {
    const out = stripAnsi(formatLine(k, 'x '.repeat(100), false, 60));
    assert.ok(out.startsWith(tag), out);
    for (const l of out.split('\n')) assert.ok(visLen(l) <= 60, `${visLen(l)}: ${l}`);
  }
  assert.strictEqual(stripAnsi(formatLine('warn', '⚠ hola', false, 80)), '[WARN]  hola', 'quita el símbolo antiguo');
  const f = fitAnsi('\x1b[32m' + 'a'.repeat(50) + '\x1b[0m', 20);
  assert.strictEqual(visLen(f), 20);
  assert.ok(stripAnsi(f).endsWith('…'));
  assert.ok([].concat(wrap('palabra '.repeat(30), 40, 8)).every((l) => l.length <= 40));
});

test('orden numérico de capítulos y subcapítulos', () => {
  const ids = ['10.1', '2.10', '2', '1.1', '2.2', '1.0', '1'];
  assert.deepStrictEqual([...ids].sort(cmpIds), ['1', '1.0', '1.1', '2', '2.2', '2.10', '10.1']);
  assert.strictEqual(moduleOf('2.3'), '2');
  assert.strictEqual(moduleOf('2'), '2');
});

test('registro detallado: todo va al archivo, sin colores', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccna-log-'));
  const file = path.join(dir, 'ccna-dl.log');
  setVerbosity(1);
  log.detail('detalle con https://x/y.png');
  setLogFile(file);
  log.warn('\x1b[33maviso\x1b[0m');
  setLogFile(null);
  const txt = fs.readFileSync(file, 'utf8');
  assert.match(txt, /detalle con https:\/\/x\/y\.png/);
  assert.match(txt, /\[WARN\]\s+aviso/);
  assert.ok(!/\x1b\[/.test(txt));
  setVerbosity(2);
});

// --- Zona dinámica: nada se parte ni se duplica (terminales de 80 y 60 columnas, títulos largos y emoji) ---
const { EventEmitter } = require('events');
const { LiveArea } = require('../lib/ui/live');
const { strWidth, physRows } = require('../lib/ui/text');
const { cleanTitle, moduleTitleFrom } = require('../lib/ui/titles');

test('ancho visible: emoji y CJK = 2, combinantes = 0, ANSI = 0', () => {
  assert.strictEqual(strWidth('abc'), 3);
  assert.strictEqual(strWidth('\x1b[31mabc\x1b[0m'), 3);
  assert.strictEqual(strWidth('🚀'), 2);
  assert.strictEqual(strWidth('⚠️'), 2);
  assert.strictEqual(strWidth('漢字'), 4);
  assert.strictEqual(strWidth('e\u0301'), 1);
  assert.strictEqual(strWidth('Módulo'), 6);
});

test('títulos de Netacad: sin "Módulo N: … | " ni número repetido', () => {
  const raw = 'Módulo 3: Conceptos de Seguridad en Redes | 3.1. Estado Actual de la Ciberseguridad';
  assert.strictEqual(cleanTitle('3.1', raw), 'Estado Actual de la Ciberseguridad');
  assert.strictEqual(cleanTitle('3.0', 'Módulo 3: Conceptos de Seguridad en Redes | 3.0. Introducción'), 'Introducción');
  assert.strictEqual(cleanTitle('3.1', '3.1 Estado\n   Actual'), 'Estado Actual');
  assert.strictEqual(cleanTitle('3', 'Módulo 3: Conceptos de Seguridad en Redes'), 'Conceptos de Seguridad en Redes');
  assert.strictEqual(moduleTitleFrom(raw), 'Conceptos de Seguridad en Redes');
});

function fakeTerm(cols) {
  const out = new EventEmitter();
  out.columns = cols;
  out.isTTY = true;
  out.chunks = [];
  out.write = (s) => {
    out.chunks.push(s);
    return true;
  };
  return out;
}

for (const cols of [80, 60]) {
  test(`zona dinámica a ${cols} columnas: líneas <= ${cols - 1} y sube tantas filas como dibujó`, () => {
    const out = fakeTerm(cols);
    const long = 'Módulo 3: Conceptos de Seguridad en Redes | 3.1. Estado Actual de la Ciberseguridad 🚀🔐 漢字\n  con salto';
    let n = 0;
    const render = () => {
      n++;
      return [`⠋ 3   ${long}  ██████░░░░ 22%  2/12`, `    ⚠️ 3.1 ${long} ${'█'.repeat(30)} 100%  16s`, `    · 3.2 x`, `total ${n}`];
    };
    const area = new LiveArea(render, 1000, out, () => out.columns);
    for (let i = 0; i < 5; i++) area.draw();
    area.print('[INFO] mensaje fijo');
    out.columns = cols - 25; // la terminal se estrecha: las líneas ya dibujadas se re-parten
    const resizeAt = area.stats.moves.length;
    out.emit('resize');
    area.draw();
    area.stop();
    const all = out.chunks.join('');
    // ninguna línea visible supera columnas-1 (con el ancho de ese momento)
    for (const line of all.replace(/\r(\x1b\[\d+A)?\x1b\[J/g, "\n").replace(/\x1b\[\?25[lh]/g, "").split('\n')) {
      assert.ok(strWidth(line) <= cols - 1, `línea de ${strWidth(line)} cols: ${JSON.stringify(line)}`);
    }
    // cada borrado sube exactamente las filas físicas dibujadas antes
    const { moves, rows } = area.stats;
    for (let i = 0; i < moves.length; i++) {
      const isResize = i === resizeAt; // el borrado al cambiar de tamaño
      if (!isResize) assert.strictEqual(moves[i], rows[i], `borrado ${i}`);
    }
    // tras el resize se suben las filas re-partidas (4 líneas de hasta cols-1 en cols-25 columnas)
    assert.ok(moves[resizeAt] > rows[resizeAt], 'tras estrechar, sube más filas (re-partidas)');
    // el mensaje fijo aparece una sola vez
    assert.strictEqual(all.split('[INFO] mensaje fijo').length - 1, 1);
    // las secuencias \x1b[NA coinciden con los borrados (N = filas - 1)
    const ups = [...all.matchAll(/\r(?:\x1b\[(\d+)A)?\x1b\[J/g)].map((m) => Number(m[1] || 0) + 1);
    assert.deepStrictEqual(ups, moves);
    assert.ok(physRows(cols - 1, cols - 25) >= 2);
  });
}
