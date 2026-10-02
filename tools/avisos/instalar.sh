#!/bin/bash
# Instala (o actualiza) en el iMac el enviador de avisos con la app cerrada de
# Cose Coro, para que corra siempre en segundo plano (launchd).
#
# Uso, desde la carpeta del proyecto:   bash tools/avisos/instalar.sh
# Se puede correr las veces que haga falta: cada vez copia la versión nueva y
# reinicia el enviador. Las llaves (vapid.json) y el estado no se tocan.
#
# Necesita: macOS, Node 18 o más nuevo, y la sesión del Firebase CLI de este
# equipo (npx firebase-tools login), la misma que usa el medidor.
set -euo pipefail

LABEL="com.cosecoro.avisos"
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATOS="$HOME/Library/Application Support/CoseCoro"
DEST="$DATOS/avisos"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/cosecoro-avisos.log"
DOMINIO="gui/$(id -u)"

if [ "$(uname)" != "Darwin" ]; then
  echo "Esto es para el iMac (macOS). Aquí no hago nada."
  exit 1
fi

# --- revisar lo necesario ------------------------------------------------------
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "No encontré Node. Instálalo desde https://nodejs.org (versión LTS) y vuelve a correr esto."
  exit 1
fi
NODE_MAYOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAYOR" -lt 18 ]; then
  echo "Node es muy viejo (versión $NODE_MAYOR). Hace falta la 18 o más nueva: https://nodejs.org"
  exit 1
fi
NPM="$(dirname "$NODE")/npm"
[ -x "$NPM" ] || NPM="$(command -v npm || true)"
if [ -z "$NPM" ]; then
  echo "No encontré npm (viene con Node). Reinstala Node desde https://nodejs.org"
  exit 1
fi
if [ ! -f "$HOME/.config/configstore/firebase-tools.json" ]; then
  echo "Falta la sesión de Firebase en este equipo. Corre primero:  npx firebase-tools login"
  exit 1
fi
for f in avisos-push.cjs package.json package-lock.json "$LABEL.plist"; do
  if [ ! -f "$AQUI/$f" ]; then echo "Falta el archivo tools/avisos/$f"; exit 1; fi
done

# --- copiar el programa (fuera del Escritorio: macOS no deja leerlo en segundo plano)
mkdir -p "$DEST" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
chmod 700 "$DATOS"
cp "$AQUI/avisos-push.cjs" "$AQUI/package.json" "$AQUI/package-lock.json" "$DEST/"
echo "Instalando lo que necesita (puede tardar un poco)…"
cd "$DEST"
if ! "$NPM" ci --omit=dev --no-audit --no-fund; then
  echo "npm ci falló; pruebo con npm install…"
  "$NPM" install --omit=dev --no-audit --no-fund
fi
"$NODE" --check "$DEST/avisos-push.cjs"

# --- preparar el servicio (launchd) ------------------------------------------------
# Las rutas se escriben con Node para que los espacios y signos raros no estorben.
"$NODE" -e '
const fs = require("fs");
const [tpl, out, node, dest, log] = process.argv.slice(1);
const xml = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
let t = fs.readFileSync(tpl, "utf8");
t = t.split("__NODE__").join(xml(node)).split("__DEST__").join(xml(dest)).split("__LOG__").join(xml(log));
fs.writeFileSync(out, t);
' "$AQUI/$LABEL.plist" "$PLIST" "$NODE" "$DEST" "$LOG"
if command -v plutil >/dev/null 2>&1; then plutil -lint "$PLIST" >/dev/null; fi

# --- (re)arrancar ----------------------------------------------------------------------
launchctl bootout "$DOMINIO/$LABEL" 2>/dev/null || true
sleep 1
# si el registro creció mucho (más de 5 MB), se queda con lo último
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 5242880 ]; then
  tail -n 5000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
launchctl enable "$DOMINIO/$LABEL" 2>/dev/null || true
OK=""
for intento in 1 2 3 4 5; do
  if launchctl bootstrap "$DOMINIO" "$PLIST" 2>/dev/null; then OK=1; break; fi
  sleep 2
done
if [ -z "$OK" ]; then
  echo "No pude arrancar el servicio. Prueba otra vez en un minuto, o reinicia el iMac."
  exit 1
fi

echo "Listo: el enviador de avisos quedó corriendo (se abre solo al prender el iMac)."
echo "Registro: $LOG"
echo "Para pararlo: launchctl bootout $DOMINIO/$LABEL"
echo
echo "Últimas líneas del registro:"
sleep 6
tail -n 15 "$LOG" 2>/dev/null || echo "(todavía no hay registro)"
