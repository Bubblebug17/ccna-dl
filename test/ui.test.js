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
