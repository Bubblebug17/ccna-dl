import { c, colorsOn } from './colors';

// Logo "ccna-dl" (figlet, fuente standard). Solo ASCII: se ve bien en PowerShell/cmd.
const LOGO = [
  '                                _ _ ',
  '  ___ ___ _ __   __ _        __| | |',
  ' / __/ __| \'_ \\ / _` |_____ / _` | |',
  '| (_| (__| | | | (_| |_____| (_| | |',
  ' \\___\\___|_| |_|\\__,_|      \\__,_|_|',
];

const SHADES = [c.cyan, c.cyan, c.blue, c.blue, c.magenta];

export function banner(version: string): string {
  const lines = LOGO.map((l, i) => (colorsOn ? c.bold(SHADES[i](l)) : l));
  lines.push(
    ' ' + c.dim('Netacad / Cisco -> HTML offline') + '  ' + c.bold(c.white('v' + version)),
    ''
  );
  return lines.join('\n');
}

export function printBanner(version: string): void {
  console.log('\n' + banner(version));
}
