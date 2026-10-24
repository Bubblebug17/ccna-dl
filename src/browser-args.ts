/**
 * Flags de Chrome. Objetivo: menos memoria y menos disco sin cambiar el render de Netacad.
 * - Se desactiva la caché atrás/adelante (BackForwardCache guardaba páginas anteriores en RAM).
 * - Caché de disco/medios mínima: los recursos los baja Node, la caché de Chrome en %TEMP% solo ocupaba disco.
 * - Sin extensiones, sincronización, actualizaciones de componentes ni redes de fondo.
 * - Tope de heap de JS por renderer (1,5 GB): si una página se desboca, se reinicia la pestaña en vez de ahogar el PC.
 * NO se usa --renderer-process-limit: obligaría a compartir proceso entre pestañas (peor aislamiento y fugas compartidas).
 */
export function chromeLaunchArgs(opts: { headful?: boolean } = {}): string[] {
  const args = [
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=IsolateOrigins,site-per-process,BackForwardCache,Translate,MediaRouter,OptimizationHints',
    '--window-size=1400,900',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-default-apps',
    '--disable-breakpad',
    '--no-first-run',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-dev-shm-usage',
    '--disk-cache-size=52428800',
    '--media-cache-size=1',
    '--js-flags=--max-old-space-size=1536',
  ];
  if (!opts.headful) args.push('--disable-gpu');
  return args;
}
