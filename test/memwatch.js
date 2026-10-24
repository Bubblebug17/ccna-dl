'use strict';
// Mide la memoria de un navegador lanzado por NOSOTROS: suma el RSS (equivale al "working set" de Windows)
// del proceso principal de Chrome y de todos sus descendientes. Solo Linux (/proc). No toca otros procesos.
const fs = require('fs');

function procTable() {
  const t = new Map();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const st = fs.readFileSync(`/proc/${d}/status`, 'utf8');
      const ppid = Number(st.match(/PPid:\s+(\d+)/)[1]);
      const rss = Number((st.match(/VmRSS:\s+(\d+)/) || [0, 0])[1]); // kB
      t.set(Number(d), { ppid, rss });
    } catch {}
  }
  return t;
}

function treeRss(rootPid) {
  const t = procTable();
  const inTree = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, p] of t) if (!inTree.has(pid) && inTree.has(p.ppid)) (inTree.add(pid), (grew = true));
  }
  let kb = 0;
  for (const pid of inTree) kb += t.get(pid)?.rss || 0;
  return { mb: kb / 1024, procs: [...inTree].filter((p) => t.has(p)).length };
}

function watch(rootPid, everyMs = 250) {
  let peak = { mb: 0, procs: 0 };
  let last = { mb: 0, procs: 0 };
  const samples = [];
  const tick = () => {
    last = treeRss(rootPid);
    samples.push(last.mb);
    if (last.mb > peak.mb) peak = last;
  };
  tick();
  const h = setInterval(tick, everyMs);
  return {
    stop() {
      clearInterval(h);
      tick();
      return { peakMb: peak.mb, peakProcs: peak.procs, lastMb: last.mb, samples };
    },
    now: () => treeRss(rootPid),
  };
}

module.exports = { treeRss, watch };
