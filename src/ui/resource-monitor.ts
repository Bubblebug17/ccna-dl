import { ChildProcess, execFile, spawn } from 'child_process';
import { readdirSync, readFileSync } from 'fs';
import { freemem, totalmem } from 'os';
import { memAvailableMb } from '../platform';

const MB = 1024 * 1024;

export type MemSample = {
  /** RSS del proceso de Node (MB). */
  nodeMb: number;
  /** Suma de la memoria de Chrome/puppeteer: proceso principal + hijos (MB), si se pudo medir. */
  chromeMb?: number;
  chromeProcs?: number;
  freeMb: number;
  totalMb: number;
};

/**
 * Mide la RAM usada cada ~2 s: Node (process.memoryUsage) + el árbol de procesos del Chrome
 * de puppeteer (no el Chrome normal del usuario).
 * - Windows: UN solo PowerShell en segundo plano (Get-CimInstance Win32_Process, sin wmic) que imprime una línea cada 2 s.
 * - Linux/Android (Termux): /proc/<pid>/status (PPid, VmRSS) y /proc/meminfo (MemAvailable); si falla, `ps`.
 * - macOS: `ps -A -o pid=,ppid=,rss=` cada 2 s.
 * Si no se puede medir Chrome, solo se muestra la de Node.
 */
export class ResourceMonitor {
  private last: MemSample = this.base();
  private timer?: NodeJS.Timeout;
  private ps?: ChildProcess;
  private peakMb = 0;

  constructor(private intervalMs = 2000) {}

  private base(): MemSample {
    return {
      nodeMb: Math.round(process.memoryUsage().rss / MB),
      freeMb: memAvailableMb() ?? Math.round(freemem() / MB),
      totalMb: Math.round(totalmem() / MB),
    };
  }

  sample(): MemSample {
    return this.last;
  }
  /** Máximo total (Node + Chrome) visto (MB). */
  peak(): number {
    return this.peakMb;
  }

  private update(chromeMb?: number, chromeProcs?: number): void {
    const b = this.base();
    const prev = this.last;
    this.last = {
      ...b,
      chromeMb: chromeMb ?? prev.chromeMb,
      chromeProcs: chromeProcs ?? prev.chromeProcs,
    };
    this.peakMb = Math.max(this.peakMb, b.nodeMb + (this.last.chromeMb ?? 0));
  }

  /** Empieza a medir. `browserPid`: PID del Chrome lanzado por puppeteer (browser.process()?.pid). */
  start(browserPid?: number): this {
    this.stop();
    this.update();
    if (browserPid && process.platform === 'win32') this.startWindows(browserPid);
    this.timer = setInterval(() => {
      if (browserPid && process.platform !== 'win32') this.pollPs(browserPid);
      else this.update();
    }, this.intervalMs);
    this.timer.unref();
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.ps && !this.ps.killed) this.ps.kill();
    this.ps = undefined;
  }

  private pollPs(root: number): void {
    if (process.platform === 'linux' || process.platform === ('android' as NodeJS.Platform)) {
      const t = procTree(root);
      if (t !== null) return this.update(t ? Math.round(t.sum / 1024) : undefined, t?.n);
    }
    execFile('ps', ['-A', '-o', 'pid=,ppid=,rss='], { timeout: 1500 }, (err, stdout) => {
      if (err) return this.update();
      const kids = new Map<number, number[]>();
      const rss = new Map<number, number>();
      for (const line of stdout.split('\n')) {
        const [pid, ppid, kb] = line.trim().split(/\s+/).map(Number);
        if (!pid) continue;
        rss.set(pid, kb);
        if (!kids.has(ppid)) kids.set(ppid, []);
        kids.get(ppid)!.push(pid);
      }
      const t = sumTree(root, kids, rss);
      this.update(t ? Math.round(t.sum / 1024) : undefined, t?.n);
    });
  }

  private startWindows(root: number): void {
    const secs = Math.max(1, Math.round(this.intervalMs / 1000));
    const script = `
$root = ${Math.floor(root)}
while ($true) {
  try {
    $procs = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize -ErrorAction Stop
    $kids = @{}; $byId = @{}
    foreach ($q in $procs) {
      $id = [int]$q.ProcessId; $pp = [int]$q.ParentProcessId; $byId[$id] = $q
      if (-not $kids.ContainsKey($pp)) { $kids[$pp] = New-Object System.Collections.ArrayList }
      [void]$kids[$pp].Add($id)
    }
    $sum = [int64]0; $n = 0; $seen = @{}
    $stack = New-Object System.Collections.Stack; $stack.Push($root)
    while ($stack.Count -gt 0) {
      $id = $stack.Pop()
      if ($seen.ContainsKey($id)) { continue }; $seen[$id] = 1
      if ($byId.ContainsKey($id)) { $sum += [int64]$byId[$id].WorkingSetSize; $n++ }
      if ($kids.ContainsKey($id)) { foreach ($k in $kids[$id]) { if ($k -ne $id) { $stack.Push($k) } } }
    }
    [Console]::Out.WriteLine("$sum $n"); [Console]::Out.Flush()
  } catch { [Console]::Out.WriteLine("ERR"); [Console]::Out.Flush() }
  Start-Sleep -Seconds ${secs}
}`;
    try {
      // -EncodedCommand (UTF-16LE en base64) evita problemas de comillas en PowerShell
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      this.ps = ps;
      ps.unref();
      (ps.stdout as unknown as { unref?: () => void })?.unref?.();
      let buf = '';
      ps.stdout?.on('data', (d: Buffer) => {
        buf += d.toString();
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          const [s, n] = line.split(/\s+/).map(Number);
          if (Number.isFinite(s) && Number.isFinite(n) && n > 0) this.update(Math.round(s / MB), n);
        }
      });
      ps.on('error', () => (this.ps = undefined));
      ps.on('exit', () => (this.ps = undefined));
      process.once('exit', () => {
        if (this.ps && !this.ps.killed) this.ps.kill();
      });
    } catch {
      this.ps = undefined;
    }
  }
}

export function sumTree(
  root: number,
  kids: Map<number, number[]>,
  size: Map<number, number>
): { sum: number; n: number } | undefined {
  if (!size.has(root)) return undefined;
  let sum = 0;
  let n = 0;
  const seen = new Set<number>();
  const stack = [root];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const s = size.get(id);
    if (s !== undefined) {
      sum += s;
      n++;
    }
    for (const k of kids.get(id) ?? []) if (k !== id) stack.push(k);
  }
  return { sum, n };
}

export function fmtMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

/** Texto corto del indicador: "RAM 2.3 GB (node 180 MB · chrome 2.1 GB/9) · libre 5.2 GB". */
export function memText(s: MemSample): string {
  const total = s.nodeMb + (s.chromeMb ?? 0);
  const parts = [`node ${fmtMb(s.nodeMb)}`];
  if (s.chromeMb !== undefined) parts.push(`chrome ${fmtMb(s.chromeMb)}${s.chromeProcs ? `/${s.chromeProcs}p` : ''}`);
  return `RAM ${fmtMb(total)} (${parts.join(' · ')}) · libre ${fmtMb(s.freeMb)}`;
}

/** Proceso global: el CLI lo arranca al lanzar Chrome y las barras lo leen. */
export const monitor = new ResourceMonitor();

/**
 * Suma VmRSS (kB) del árbol de `root` leyendo /proc. null si /proc no se puede leer
 * (el llamador cae a `ps`); undefined si el proceso raíz ya no existe.
 */
export function procTree(root: number, procDir = '/proc'): { sum: number; n: number } | undefined | null {
  let entries: string[];
  try {
    entries = readdirSync(procDir).filter((d) => /^\d+$/.test(d));
  } catch {
    return null;
  }
  const kids = new Map<number, number[]>();
  const rss = new Map<number, number>();
  for (const d of entries) {
    try {
      const st = readFileSync(`${procDir}/${d}/status`, 'utf8');
      const ppid = Number(/^PPid:\s+(\d+)/m.exec(st)?.[1]);
      const kb = Number(/^VmRSS:\s+(\d+)/m.exec(st)?.[1] ?? 0);
      const pid = Number(d);
      rss.set(pid, kb);
      if (!kids.has(ppid)) kids.set(ppid, []);
      kids.get(ppid)!.push(pid);
    } catch {
      // proceso que terminó o sin permiso (Android oculta procesos de otras apps): se ignora
    }
  }
  if (rss.size === 0) return null;
  return sumTree(root, kids, rss);
}
