# ccna-dl

A simple tool for downloading your CCNA course from the website.

## OUT OF DATE

This downloader seems to be broken by now ([#1](/../../issues/1)). I won't fix it, but would accept PRs or transfer the npm package.

## Features

- download the whole course contents
- clicks through carousels and stacks their contents
- does _not_ work for videos

## Run this tool

- Install [Node.js + npm](https://nodejs.org/)
- `npx ccna-dl --help`

## Usage

- Head to [netacad.com](netacad.com)
- Launch your course
- Copy the link that leads to the course contents (not the link in the address bar):  
  <img src="./img/copy-link-example.png" width="30%">
- `npx ccna-dl -u <YOUR_EMAIL> <COURSE_URL>`

## Velocidad, paralelismo y esperas (modo HTML offline)

Node es de un solo hilo, pero casi todo el tiempo de la descarga se va **esperando al sitio** (cargas, efectos de 1–2 s,
descarga de recursos). Por eso la descarga en paralelo usa **varias pestañas del mismo navegador y sesión**, no hilos.

| Opción | Por defecto | Qué hace |
| --- | --- | --- |
| `--concurrency N` | `3` (máx. 6) | Capítulos que se descargan a la vez (pestañas en paralelo). `1` = secuencial como antes. |
| `--min-wait ms` | `1500` | Espera mínima de asentamiento, **además** de las condiciones (sin spinner/esqueleto, DOM estable, imágenes y red en reposo). Súbela (p. ej. `2500`) si tu conexión es lenta. |
| `--chapter-timeout s` | `300` | Tiempo máximo por intento de capítulo; al agotarse se reinicia la pestaña y se reintenta. |
| `--fast` | desactivado | Modo agresivo (opt-in): esperas mínimas más cortas y bloquea también audio/vídeo y `adobedtm`. |
| `--no-block-trackers` | bloqueo activo | No bloquear analíticas/publicidad (por defecto no se cargan; no afectan al contenido). |
| `--screenshot` | desactivado | Guarda la captura de depuración `course.png`. |

- **Captura segura**: cada página espera por condición, se verifica tras guardar (spinner/esqueleto/imágenes pendientes) y, si la carga no había terminado, se
  re-captura automáticamente una vez; si aun así queda incompleta se marca `parcial` y al reanudar se rehace.
- **Ctrl+C**: la primera vez termina de escribir los capítulos en curso (escritura atómica) y para; vuelve a ejecutar **el mismo comando** para continuar (se omiten los ya verificados).
- Los recursos compartidos entre capítulos (CSS, fuentes, imágenes comunes) se descargan **una sola vez**.
- Empieza con `--concurrency 3`; si Netacad devuelve errores o "Sesión no válida", baja a `1`–`2`.

## Disclaimer

This project is only for educational purposes. Don't download stuff with this tool please.
