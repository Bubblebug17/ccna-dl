/** Opciones quitadas o renombradas: si se usan, error claro en vez de fallar en silencio. */
export const RENAMED_FLAGS: Record<string, string> = {
  '--dump-network': '--debug-network',
  '--screenshot': '--debug-screenshot',
  '--headful': '--debug-headful',
};

export const REMOVED_FLAGS: Record<string, string> = {
  '--format': 'era del modo PDF de la interfaz clásica de Netacad, que ya no existe',
  '--timeout': 'era del modo PDF; usa --chapter-timeout (segundos por capítulo)',
  '-t': 'era --timeout del modo PDF; usa --chapter-timeout',
  '--block-media': 'ahora lo hace --no-videos (bloquea vídeo/audio además de no capturarlos)',
};

export function removedFlagErrors(argv: string[]): string[] {
  const out: string[] = [];
  for (const a of argv) {
    if (a === '--') break;
    const name = a.split('=')[0];
    if (RENAMED_FLAGS[name]) out.push(`La opción ${name} se renombró: usa ${RENAMED_FLAGS[name]}.`);
    else if (REMOVED_FLAGS[name]) out.push(`La opción ${name} se quitó: ${REMOVED_FLAGS[name]}.`);
  }
  return out;
}
