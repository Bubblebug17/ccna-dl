const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isTermux, resolveBrowser, which, memAvailableMb } = require('../lib/platform');
const { chromeLaunchArgs } = require('../lib/browser-args');
const { procTree } = require('../lib/ui/resource-monitor');

test('isTermux detecta PREFIX, TERMUX_VERSION y android', () => {
  assert.equal(isTermux({ PREFIX: '/data/data/com.termux/files/usr' }, 'linux'), true);
  assert.equal(isTermux({ TERMUX_VERSION: '0.118' }, 'linux'), true);
  assert.equal(isTermux({}, 'android'), true);
  assert.equal(isTermux({ PREFIX: '/usr' }, 'linux'), false);
  assert.equal(isTermux({ TERMUX_VERSION: '1', CCNA_DL_TERMUX: '0' }, 'linux'), false);
});

test('resolveBrowser: --browser-path > PUPPETEER_EXECUTABLE_PATH > Chromium de Termux', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tx-'));
  fs.mkdirSync(path.join(dir, 'bin'));
  const chromium = path.join(dir, 'bin', 'chromium-browser');
  fs.writeFileSync(chromium, '', { mode: 0o755 });
  const env = { PREFIX: dir, PATH: '/nonexistent' };
  assert.equal(resolveBrowser('/x/chrome', env, true).path, '/x/chrome');
  assert.equal(resolveBrowser(undefined, { ...env, PUPPETEER_EXECUTABLE_PATH: '/y' }, true).path, '/y');
  assert.equal(resolveBrowser(undefined, env, true).path, chromium);
  assert.equal(resolveBrowser(undefined, env, false).path, undefined);
  assert.equal(resolveBrowser(undefined, { PATH: '/nonexistent' }, true).path, undefined);
  assert.equal(which(['chromium', 'chromium-browser'], env), chromium);
});

test('chromeLaunchArgs lowMemory añade --no-sandbox y baja el heap', () => {
  const a = chromeLaunchArgs({ lowMemory: true });
  for (const f of ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']) assert.ok(a.includes(f), f);
  assert.ok(a.includes('--js-flags=--max-old-space-size=512'));
  assert.ok(!chromeLaunchArgs().includes('--no-sandbox'));
});

test('procTree suma VmRSS del árbol y degrada si /proc no existe', () => {
  const t = procTree(process.pid);
  if (process.platform === 'linux') assert.ok(t && t.sum > 0 && t.n >= 1);
  assert.equal(procTree(process.pid, '/no/existe'), null);
  if (process.platform === 'linux') assert.ok(memAvailableMb() > 0);
});
