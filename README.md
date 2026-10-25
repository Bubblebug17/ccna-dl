# ccna-dl

Descarga cursos de [Netacad](https://www.netacad.com/) de tipo **launch** como **HTML offline**, para leerlos sin conexión desde el navegador.

Es un fork de [garzj/ccna-dl](https://github.com/garzj/ccna-dl). El original descargaba la interfaz clásica de Netacad, que ya no existe. Esta versión está reescrita para los cursos actuales.

## Qué hace

- Guarda cada capítulo como un HTML autónomo y crea un `index.html` con enlaces a todos.
- Descarga los recursos (CSS, fuentes, imágenes y archivos) una sola vez y los reutiliza entre capítulos.
- **Vídeos:** activa cada reproductor y descarga el vídeo (mp4, o HLS/DASH convertido con ffmpeg) junto con su póster y subtítulos.
- **Animaciones interactivas** (`<adobe-animate-view>`, p. ej. 2.3.2): pulsa «play» y graba cada una en un `.webm` local.
- **Pestañas, carruseles y gráficos dinámicos:** los guarda con su contenido y estilos.
- Descarga varios capítulos en paralelo (pestañas del mismo navegador), reanuda descargas y reintenta lo que falla.
- Verifica cada capítulo después de guardarlo y lo vuelve a capturar si quedó incompleto.

## Requisitos

- **Node.js** 20 o 22. Los scripts de `scripts/` funcionan con Node ≥ 16.
- **Cuenta de Netacad** con acceso al curso.
- **Chrome:** Puppeteer descarga el suyo al hacer `npm install`.
- **ffmpeg** (opcional): solo hace falta para los vídeos en streaming (`.m3u8`/`.mpd`). Tiene que estar en el `PATH` o indicarse con `FFMPEG_PATH`.

## Instalación

```powershell
git clone https://github.com/Bubblebug17/ccna-dl.git
cd ccna-dl
npm install
npm run build          # compila src/ → lib/
node lib/cli.js --help
```

Cada vez que cambies algo en `src/`, vuelve a ejecutar `npm run build`.

## Configuración

```powershell
Copy-Item .env.example .env
```

Escribe tu contraseña de Netacad en `PASSWORD=`. Si la dejas vacía, el programa te la pide por consola. El archivo `.env` está en `.gitignore`: no lo compartas.

## Cómo obtener la URL del curso

1. Entra en netacad.com y abre tu curso.
2. Copia el enlace que lleva al contenido del curso (`https://www.netacad.com/<idioma>/launch?id=...`), no el de la barra de direcciones:

   <img src="./img/copy-link-example.png" width="30%">

## Uso

Pon siempre la URL **entre comillas**: en PowerShell, `&` y `?` tienen significado especial.

```powershell
# Curso completo
node lib/cli.js --user tu@correo.com --out-dir D:\cursos "https://www.netacad.com/es/launch?id=<id>"

# Solo una parte: módulo, capítulo, lista o rango
node lib/cli.js -u tu@correo.com --only 2 "<url>"
node lib/cli.js -u tu@correo.com --only 2.3 "<url>"
node lib/cli.js -u tu@correo.com --only 2.1,2.3 "<url>"
node lib/cli.js -u tu@correo.com --only 2.1-2.4 "<url>"

# Rehacer capítulos ya descargados
node lib/cli.js -u tu@correo.com --only 2.3 --force "<url>"

# Reintentar solo lo que falló en la ejecución anterior
node lib/cli.js -u tu@correo.com --retry-failed "<url>"

# Menos memoria o más paralelismo
node lib/cli.js -u tu@correo.com --concurrency 1 --recycle-every 4 "<url>"

# Más rápido y ligero: sin vídeos ni animaciones
node lib/cli.js -u tu@correo.com --no-videos --no-animations "<url>"

# Volver a leer el índice del curso (ignora outline-cache.json)
node lib/cli.js -u tu@correo.com --only 3 --refresh-outline "<url>"

# Validar las descargas sin conexión (no inicia sesión)
node lib/cli.js --validate --out-dir D:\cursos
```

Si ejecutas el mismo comando otra vez, se omiten los capítulos ya verificados y se continúa con lo que falta. Con **Ctrl+C**, el programa termina de escribir los capítulos en curso y se detiene; para seguir, vuelve a ejecutar el mismo comando.

## Opciones

| Opción | Por defecto | Descripción |
|---|---|---|
| `<urls…>` | — | Una o más URLs de cursos launch. |
| `-u`, `--user` | — | Correo o usuario de Netacad (no hace falta con `--validate`). |
| `-o`, `--out-dir` | `.` | Carpeta donde se guardan los cursos. |
| `-c`, `--concurrency` | `2` (`1` en Termux) | Subcapítulos a la vez (pestañas), máximo 6. En Termux/Android el valor por defecto es 1 (puedes subirlo a mano). Baja automáticamente si hay poca RAM libre. Cada pestaña puede usar ~1 GB. |
| `--only` | — | Solo parte del curso: `2`, `2.3`, `2.1,2.3,5`, `2.1-2.4`, `2-4`. El índice y el resumen se mezclan con lo ya descargado. |
| `--force` | no | Vuelve a descargar aunque el capítulo ya exista y esté verificado. |
| `--retry-failed` | no | Descarga solo los capítulos de `descarga-fallos.json`. |
| `--refresh-outline` | no | Con `--only`: ignora `outline-cache.json` y vuelve a leer el índice del curso. |
| `--validate` | no | Valida sin conexión las descargas de `--out-dir` y escribe `validation-report.md`. No descarga nada. |
| `--recycle-every` | `8` | Cada cuántos capítulos se reabre cada pestaña para liberar memoria (`0` = nunca). |
| `--no-videos` | no | No descarga vídeos (solo guarda el póster) y bloquea vídeo/audio. |
| `--no-animations` | no | No graba las animaciones interactivas. |
| `--min-wait` | `1500` | Milisegundos mínimos que el contenido debe estar cargado antes de guardarlo. Súbelo con conexiones lentas. |
| `--chapter-timeout` | `300` | Segundos máximos por intento de capítulo. |
| `--retries` | `3` | Reintentos para recursos y capítulos que fallan. |
| `--asset-concurrency` | `6` | Recursos descargados a la vez por capítulo. |
| `--fast` | no | Modo rápido y menos seguro: esperas más cortas y más bloqueos. |
| `--no-block-trackers` | no | No bloquea analítica ni publicidad (por defecto se bloquean). |
| `-v`, `--verbose` | `2` | Nivel de detalle `1`-`3`: `1` = mínimo (barras, avisos, errores y resumen), `2` = normal (pasos principales y resultado de cada subcapítulo), `3` = detallado (login paso a paso, reintentos, omitidos, reciclado de pestañas). |
| `--no-banner` | no | No muestra el logo ASCII al iniciar. |
| `--no-color` | no | Sin colores. También con la variable `NO_COLOR=1` o al redirigir la salida a un archivo. |
| `--no-progress` | no | Sin barras ni spinners, solo líneas de texto. Es automático si la salida no es una terminal. |
| `-h`, `--help` | — | Muestra la ayuda. |

### Interfaz en la terminal

Términos: **capítulo** = módulo del curso (`1`, `2`…); **subcapítulo** = cada apartado (`1.0`, `1.1`…); **índice del curso** = la lista de capítulos que se lee de Netacad.

Al iniciar se muestra el logo de `ccna-dl`. Durante la descarga verás una barra por capítulo, en orden, y debajo sus subcapítulos:

```
[WARN]  14 recursos del curso no existen en el servidor (fuentes); se omiten en todos los subcapítulos.
[WARN]  1.2 Configurar puertos de un switch: 3 recursos no existen en el servidor, 1 vídeo sin reproductor offline
✔ 1   Configuración básica de dispositivos             ████████████████       100%    5/5
    ✔ 1.1   Configuración de un switch con parámetros  ████████████████       100%     8s
    ⚠ 1.2   Configurar puertos de un switch            ████████████████       100%     9s
⠹ 2   Conceptos de switching                           ██████░░░░░░░░░░        38%    2/5
    ✔ 2.0   Introducción                               ████████████████       100%     8s
    ⠼ 2.1   Reenvío de tramas                          ███████░░░░░░░░░    12s  recursos
    · 2.2   Dominios de switching                      ░░░░░░░░░░░░░░░░       pendiente
 ███████░░░░░░░░░░░░░░░ 7/31 subcapítulos · 23% · 1m10s ETA 3m50s
 ▣ RAM 2.4 GB (node 160 MB · chrome 2.2 GB/9p) · libre 5.1 GB · pico 2.9 GB
```

- Cada mensaje va en su propia línea con una etiqueta que se lee bien sin colores: `[INFO]`, `[OK]`, `[WARN]`, `[ERROR]`. Ninguna línea pasa del ancho de la terminal: los mensajes largos siguen en la línea siguiente con sangría y en las barras se recorta el título con `…`.
- El % de un capítulo es la suma del avance de sus subcapítulos. Un capítulo terminado queda fijo encima; abajo solo se redibujan los capítulos en curso, la barra total y la RAM. Si no cabe en la altura de la terminal se resume con «… y N más pendientes».
- Los avisos son cortos y agrupados (sin URLs). Las fuentes del curso que faltan en el servidor (ciscoSansTT…) se avisan **una sola vez**. El detalle completo (URLs, códigos HTTP, errores) va a `<carpeta del curso>/ccna-dl.log` y a la pantalla con `-v 3`.
- La carpeta de salida y el `index.html` se muestran con la ruta absoluta.
- El indicador de memoria se actualiza cada ~2 s: Node más todos los procesos del Chrome de puppeteer (no tu Chrome normal). Amarillo con menos de 1,5 GB libres y rojo con menos de 700 MB.

Si la salida va a un archivo (`> log.txt`) o usas `--no-progress`, se escriben solo líneas de texto con las mismas etiquetas, sin colores.

```powershell
# Salida mínima
node lib/cli.js -u tu@correo.com -v 1 "<url>"
# Todo el detalle
node lib/cli.js -u tu@correo.com -v 3 --only 2.3 "<url>"
```

### Depuración

Todo lo que generan estas opciones se guarda en `<curso>/debug/`.

| Opción | Descripción |
|---|---|
| `--debug-network` | Guarda `debug/red-<capítulo>.json` con las peticiones de red y las animaciones detectadas, sin cookies, cabeceras ni tokens. Úsala con `--only`. |
| `--debug-screenshot` | Guarda `debug/course.png` con una captura de la vista del curso tras el login. |
| `--debug-headful` | Abre el navegador con ventana visible. |
| `--browser-path RUTA` | Chrome/Chromium a usar (también `PUPPETEER_EXECUTABLE_PATH`; en Termux se detecta solo). |

Los nombres antiguos (`--dump-network`, `--screenshot`, `--headful`) terminan con un error que indica el nuevo. También se quitaron `--format`, `--timeout`/`-t` y `--block-media`.

## Scripts

```powershell
# Validador offline (no modifica nada)
node scripts/validate-download.js --root D:\cursos [--course <texto>] [--out informe.md] [--json informe.json]

# Limpia subtemas falsos y capítulos pisados por cuestionarios en descargas antiguas
node scripts/clean-fake-chapters.js --root D:\cursos            # simulación (--dry-run, por defecto)
node scripts/clean-fake-chapters.js --root D:\cursos --apply    # aplica y guarda copia en <curso>/.limpieza-*/
```

## Uso en Termux (Android)

Funciona en un teléfono Android (probado para Android 15, aarch64) usando el **Chromium de Termux** en lugar del Chrome que descarga puppeteer (no existe para Android). El programa detecta Termux solo (`PREFIX` con `com.termux`, `TERMUX_VERSION` o Node para Android) y entonces:

- usa `$PREFIX/bin/chromium-browser` (o `chromium`); `--browser-path` o `PUPPETEER_EXECUTABLE_PATH` tienen prioridad;
- lanza Chromium sin ventana con `--no-sandbox --disable-gpu --disable-dev-shm-usage`, heap de JS de 512 MB y sin procesos de fondo; los avisos de dbus/inotify de Chromium no se muestran;
- baja los valores por defecto: `--concurrency 1`, `--recycle-every 3`, `--asset-concurrency 3` (puedes cambiarlos con las mismas opciones);
- mide la memoria con `/proc/<pid>/status` y `/proc/meminfo` (si Android no deja leerlos, el indicador solo muestra Node);
- `--debug-headful` no está disponible (no hay pantalla).

### Instalación paso a paso

```bash
pkg update && pkg upgrade
pkg install nodejs-lts git ffmpeg x11-repo
pkg install chromium
termux-setup-storage            # solo si quieres guardar en el almacenamiento del teléfono (acepta el permiso)

git clone https://github.com/Bubblebug17/ccna-dl
cd ccna-dl
git checkout feat/termux
PUPPETEER_SKIP_DOWNLOAD=1 npm install   # no descarga Chrome (también lo omite .puppeteerrc.cjs en Termux)
npm run build
bash scripts/termux-check.sh            # comprueba arquitectura, RAM, node, chromium, ffmpeg y una prueba sin ventana
cp .env.example .env && nano .env       # opcional: PASSWORD=
```

### Uso

```bash
termux-wake-lock    # evita que Android suspenda Termux con la pantalla apagada (termux-wake-unlock al terminar)
node lib/cli.js -u tu@correo.com -c 1 --only 1 \
  --out-dir ~/storage/shared/Download/ccna "https://www.netacad.com/es/launch?id=<id>"
```

`~/storage/shared/...` es el almacenamiento interno del teléfono (carpeta `Download/ccna` en el explorador de archivos). Si no existe, ejecuta `termux-setup-storage`.

### Consejos de RAM

- Cierra las demás apps antes de empezar; Chromium + Node usan ~600 MB–1 GB con una pestaña.
- Descarga por partes con `--only` (módulo a módulo) y usa `--resume`/sin `--force` para continuar.
- Si va justo de memoria: `--no-animations`, `--no-videos` o `--recycle-every 1`.
- Mantén `termux-wake-lock` activo y el teléfono cargando; quita la optimización de batería de Termux en Ajustes.

### Plan B: proot-distro con Debian

Si el Chromium de Termux falla (por ejemplo tras una actualización), usa Debian dentro de Termux:

```bash
pkg install proot-distro
proot-distro install debian
proot-distro login debian
apt update && apt install -y chromium ffmpeg git nodejs npm
git clone https://github.com/Bubblebug17/ccna-dl && cd ccna-dl && git checkout feat/termux
PUPPETEER_SKIP_DOWNLOAD=1 npm install && npm run build
node lib/cli.js --browser-path /usr/bin/chromium -c 1 --recycle-every 3 --asset-concurrency 3 -u tu@correo.com --only 1 "<url>"
```

Dentro de Debian no se detecta Termux, por eso se indican `--browser-path` y los valores bajos a mano (o `CCNA_DL_TERMUX=1` para activar el modo Termux). El almacenamiento del teléfono está en `/sdcard` si arrancas con `proot-distro login debian --bind /sdcard`.

## Carpeta de salida

```
<out-dir>/
└── <id>_<Título del curso>/
    ├── index.html               # índice con enlaces a los capítulos
    ├── chapters/1.0.html …      # un HTML por subcapítulo
    ├── assets/                  # css, fonts, img, video, files
    ├── descarga-resumen.json    # resultado de la última ejecución
    ├── descarga-fallos.json     # pendientes para --retry-failed
    ├── outline-cache.json       # caché del índice del curso para --only
    ├── ccna-dl.log              # registro detallado (URLs, códigos de error, reintentos)
    └── debug/                   # solo con opciones --debug-*
```

## Problemas comunes

| Problema | Solución |
|---|---|
| Error de URL o «no es un curso launch» | Revisa la URL (p. ej. `ttps://` sin la `h`), usa el enlace `.../launch?id=...` y ponlo entre comillas. |
| Poca RAM o el PC va lento | `--concurrency 1`, y si hace falta `--recycle-every 4`. |
| «Sesión no válida» o errores de Netacad | Baja `--concurrency` a 1 y vuelve a ejecutar el mismo comando. |
| Recursos con 404 en el resumen | Suelen ser archivos que faltan en el propio curso de Netacad. El capítulo se guarda igual. |
| Los vídeos en streaming no se descargan | Instala ffmpeg o indica su ruta en `FFMPEG_PATH`. |
| Algún capítulo queda `parcial`/`fallido` | Usa `--retry-failed`, o `--only X.Y --force`. Si tu conexión es lenta, sube `--min-wait`. |

## Más información

[DOCUMENTACION.md](./DOCUMENTACION.md) explica el funcionamiento interno, la validación, las pruebas (`npm test`), los resultados y el historial de cambios.

## Créditos y licencia

Fork de [garzj/ccna-dl](https://github.com/garzj/ccna-dl). Licencia **GPL-3.0** (ver [LICENSE](./LICENSE)).

Uso solo educativo y personal: descarga únicamente los cursos a los que tienes acceso y no redistribuyas su contenido.
