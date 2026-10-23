# ccna-dl

A simple tool for downloading your CCNA course from the website.

## OUT OF DATE

This downloader seems to be broken by now ([#1](/../../issues/1)). I won't fix it, but would accept PRs or transfer the npm package.

## Features

- download the whole course contents
- clicks through carousels and stacks their contents
- videos and interactive animations (`<adobe-animate-view>`, e.g. 2.3.2 "OSPF designated router") are recorded so that they play offline (see `--no-videos`, `--no-animations`, `--dump-network` and [DOCUMENTACION.md](./DOCUMENTACION.md) §7.6)

## Run this tool

- Install [Node.js + npm](https://nodejs.org/)
- `npx ccna-dl --help`

## Usage

- Head to [netacad.com](netacad.com)
- Launch your course
- Copy the link that leads to the course contents (not the link in the address bar):  
  <img src="./img/copy-link-example.png" width="30%">
- `npx ccna-dl -u <YOUR_EMAIL> <COURSE_URL>`
- Only part of the course (no full outline sync, one login): `--only 2` (whole module), `--only 2.3`,
  `--only 2.1,2.3,5`, `--only 2.1-2.4`. Combine with `--force` to redo just those chapters; the index and
  `descarga-resumen.json` are merged, the rest of the course is not touched. `--refresh-outline` ignores the
  cached outline (`outline-cache.json`). Details in [DOCUMENTACION.md](./DOCUMENTACION.md) §5.5.

## Velocidad, paralelismo y esperas (modo HTML offline)

Node es de un solo hilo, pero casi todo el tiempo de la descarga se va **esperando al sitio** (cargas, efectos de 1–2 s,
descarga de recursos). Por eso la descarga en paralelo usa **varias pestañas del mismo navegador y sesión**, no hilos.

| Opción | Por defecto | Qué hace |
| --- | --- | --- |
| `--concurrency N` | `2` (o menos si hay poca RAM libre; máx. 6) | Capítulos que se descargan a la vez (pestañas en paralelo). `1` = secuencial como antes. Cada pestaña puede usar ~1 GB de RAM; si `N` no cabe en la RAM libre se avisa. |
| `--recycle-every N` | `8` | Cada `N` capítulos se cierra y reabre la pestaña de cada worker para liberar la memoria de Chrome (`0` = nunca). También se recicla antes si el heap de JS pasa de ~600 MB o queda poca RAM libre. |
| `--block-media` | desactivado | Opcional: el navegador **no carga** vídeo/audio (mp4, webm, mp3…) para ahorrar memoria. Por defecto **se cargan**, porque el reproductor tiene que arrancar para que se pueda descargar el vídeo (ver `--no-videos`). |
| `--no-videos` | desactivado | No intenta capturar los vídeos (se queda el póster, como antes). Los capítulos guardados así se marcan con formato 2 y no se rehacen por tener vídeos pendientes. |
| `--no-animations` | desactivado | No pulsa «play» en las animaciones interactivas (`<adobe-animate-view>`: canvas pintado por JS) ni las graba. Sin esto se graba cada animación como vídeo `.webm` local (hasta 90 s por animación) y el capítulo se repite al reanudar si la animación quedó sin grabar. |
| `--dump-network` | desactivado | Diagnóstico: escribe `<curso>/debug-red-<capítulo>.json` con los componentes de animación detectados y las peticiones de red vistas al activarlos (**sin cookies, cabeceras ni valores de query**: solo los nombres de los parámetros). |
| `--min-wait ms` | `1500` | Espera mínima de asentamiento, **además** de las condiciones (sin spinner/esqueleto, DOM estable, imágenes y red en reposo). Súbela (p. ej. `2500`) si tu conexión es lenta. |
| `--chapter-timeout s` | `300` | Tiempo máximo por intento de capítulo; al agotarse se reinicia la pestaña y se reintenta. |
| `--fast` | desactivado | Modo agresivo (opt-in): esperas mínimas más cortas y bloquea también `adobedtm`. |
| `--no-block-trackers` | bloqueo activo | No bloquear analíticas/publicidad (por defecto no se cargan; no afectan al contenido). |
| `--screenshot` | desactivado | Guarda la captura de depuración `course.png`. |

- **Vídeos**: el programa pulsa «play» en cada reproductor, lee la fuente real (mp4 firmado o HLS/DASH), la descarga y la sustituye por un `<video controls>` local con póster y subtítulos (`.vtt` incrustado). Los vídeos en *streaming* (`.m3u8`/`.mpd`) necesitan **ffmpeg** instalado (o `FFMPEG_PATH`). No verificado con Netacad real; ver `DOCUMENTACION.md` §12.
- **Capítulos/subtemas inexistentes**: las IP del texto (`10.1.0.0/16`) ya no se toman por subtemas, y los cuestionarios `X.Y.1` ya no pisan la sección `X.Y`. Para limpiar descargas anteriores: `node scripts/clean-fake-chapters.js` (simulación) y `--apply`.
- **Captura segura**: cada página espera por condición, se verifica tras guardar (spinner/esqueleto/imágenes pendientes) y, si la carga no había terminado, se
  re-captura automáticamente una vez; si aun así queda incompleta se marca `parcial` y al reanudar se rehace.
- **Ctrl+C**: la primera vez termina de escribir los capítulos en curso (escritura atómica) y para; vuelve a ejecutar **el mismo comando** para continuar (se omiten los ya verificados).
- Los recursos compartidos entre capítulos (CSS, fuentes, imágenes comunes) se descargan **una sola vez**.
- **Memoria**: Chrome es lo que más RAM gasta. En un PC con ~16 GB usa `--concurrency 2` (por defecto) y no lo subas si el equipo ya va justo; con poca RAM libre usa `--concurrency 1`. Si ves un `Memoria: …` de aviso al arrancar, hazle caso. Más detalle en `DOCUMENTACION.md` (§11).
- Si Netacad devuelve errores o "Sesión no válida", baja a `1`–`2`.

## Disclaimer

This project is only for educational purposes. Don't download stuff with this tool please.
