#!/usr/bin/env bash
# Comprueba que Termux tiene lo necesario para ccna-dl: arquitectura, RAM, node, chromium, ffmpeg
# y una prueba de Chromium sin ventana. Uso: bash scripts/termux-check.sh
ok=0
pass() { echo "  [OK]  $*"; }
fail() { echo "  [X]   $*"; ok=1; }
warn() { echo "  [!]   $*"; }

echo "ccna-dl: comprobación de Termux"
if [ -n "$TERMUX_VERSION" ] || [[ "$PREFIX" == *com.termux* ]]; then pass "Termux $TERMUX_VERSION"; else warn "no parece Termux (PREFIX=$PREFIX)"; fi

arch=$(uname -m); case "$arch" in aarch64|arm64|x86_64) pass "arquitectura $arch";; *) warn "arquitectura $arch (probado en aarch64)";; esac

if [ -r /proc/meminfo ]; then
  total=$(awk '/^MemTotal:/{print int($2/1024)}' /proc/meminfo)
  avail=$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo)
  if [ "${avail:-0}" -ge 1200 ]; then pass "RAM disponible ${avail} MB de ${total} MB"
  else warn "RAM disponible ${avail} MB de ${total} MB: cierra apps (recomendado >= 1,2 GB)"; fi
else warn "no se pudo leer /proc/meminfo"; fi

if command -v node >/dev/null; then
  v=$(node -v); major=${v#v}; major=${major%%.*}
  if [ "$major" -ge 18 ]; then pass "node $v"; else fail "node $v (hace falta >= 18: pkg install nodejs-lts)"; fi
else fail "node no instalado (pkg install nodejs-lts)"; fi
command -v npm >/dev/null && pass "npm $(npm -v)" || fail "npm no instalado"

export PATH="${PREFIX:+$PREFIX/bin:}$PATH"
chrome="${PUPPETEER_EXECUTABLE_PATH:-$(command -v chromium-browser || command -v chromium)}"
if [ -n "$chrome" ] && [ -x "$chrome" ]; then pass "chromium: $chrome"
else fail "chromium no encontrado (pkg install x11-repo && pkg install chromium)"; chrome=""; fi

command -v ffmpeg >/dev/null && pass "ffmpeg: $(command -v ffmpeg)" || fail "ffmpeg no instalado (pkg install ffmpeg)"
command -v git >/dev/null && pass "git" || warn "git no instalado (pkg install git)"

[ -d "$HOME/storage/shared" ] && pass "almacenamiento compartido: ~/storage/shared" \
  || warn "sin ~/storage/shared: ejecuta termux-setup-storage si quieres guardar en el almacenamiento del teléfono"

if [ -n "$chrome" ]; then
  echo "  ...   prueba sin ventana (example.com)"
  out=$(DBUS_SESSION_BUS_ADDRESS=disabled: timeout 60 "$chrome" --headless --no-sandbox --disable-gpu \
        --disable-dev-shm-usage --dump-dom https://example.com 2>/dev/null)
  if echo "$out" | grep -qi "Example Domain"; then pass "Chromium sin ventana funciona"
  else fail "Chromium sin ventana no devolvió la página (¿sin conexión o poca RAM?)"; fi
fi

[ $ok -eq 0 ] && echo "Todo listo." || echo "Hay problemas: revisa las líneas [X]."
exit $ok
