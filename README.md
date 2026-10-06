# Cose Coro

App (PWA) para el personal de la sucursal Coro de Coseimpa: calculadoras de materiales, mapa de la tienda, tasa BCV, cuentas de trabajadores, chat del equipo y editor del mapa.

- En vivo: https://cosecoro.web.app (también https://cosecoro-coro.web.app; las dos publican lo mismo)
- Proyecto de Firebase: `cosecoro-coro` (plan Spark, gratis)

## Qué hay aquí

| Archivo | Qué es |
| --- | --- |
| `public/index.html` | Toda la app (HTML, CSS y JavaScript en un solo archivo) |
| `public/sw.js` | Service worker (funciona sin internet). Cambiar `CACHE` en cada versión |
| `public/manifest.json`, `public/icon-*.png` | Para instalarla en el teléfono |
| `firestore.rules` | Reglas de seguridad de la base de datos (quién puede leer y escribir qué) |
| `database.rules.json` | Reglas de la Realtime Database (solo el "en línea" del chat) |
| `firebase.json`, `.firebaserc` | Configuración de Firebase Hosting y del simulador |
| `tests/` | Pruebas de las reglas de seguridad y del enviador de avisos |
| `tools/monitor.cjs` | Medidor del plan gratis: guarda el consumo en `monitor/resumen` para la pantalla "Estado del sistema". Corre cada hora en la computadora de Rafael (`tools/com.cosecoro.monitor.plist`, instalado desde una copia en `~/Library/Application Support/CoseCoro`) |
| `tools/avisos/` | Enviador de los avisos con la app cerrada (notificaciones push). Corre siempre en el iMac (ver abajo) |

## Publicar

```bash
npx -y firebase-tools@14 deploy --only hosting,firestore:rules,database
```

Antes de publicar: subir `CACHE` en `public/sw.js` y `APP_BUILD` en `public/index.html` (mismo número).

Lo que se publica sale de `dist/`, no de `public/`: antes de cada deploy de hosting, `tools/publicar/publicar.mjs` (predeploy en `firebase.json`) copia `public/` a `dist/` con el JavaScript comprimido y revuelto y el aviso de derechos de autor. El código legible queda solo en `public/` y en este repositorio privado.

## Probar las reglas de seguridad

Necesita Java 11 o más nuevo (lo usa el simulador de Firebase).

```bash
cd tests && npm install && npm test
```

Prueba del enviador de avisos (también con el simulador):

```bash
cd tools/avisos && npm install && cd ../../tests && npm run test:avisos
```

## Avisos con la app cerrada

Cada persona lo activa en Ajustes → «Chat y avisos» → «Avisos con la app cerrada». Desde ahí le llegan al teléfono los mensajes de sus chats, los avisos del administrador, las respuestas de soporte, las solicitudes de compañero y (a Mecánicos y administración) las revisiones con fallas, aunque la app esté cerrada. En iPhone primero hay que instalar la app (Compartir → «Agregar a inicio»).

Cómo funciona: el teléfono guarda en `push/{uid}_{equipo}` su dirección de avisos. Un programa pequeño (`tools/avisos/avisos-push.cjs`) corre todo el tiempo en el iMac, mira la base de datos y manda cada aviso por el servicio de avisos del propio teléfono (Google, Apple, Mozilla o Microsoft). Es gratis y no necesita cuentas nuevas: usa la sesión del Firebase CLI del iMac (la misma del medidor) y unas llaves propias que se crean solas la primera vez.

- Instalar o actualizar (en el iMac, desde la carpeta del proyecto): `bash tools/avisos/instalar.sh`. Se puede correr otra vez cuando cambie el programa. Si dice que falta la sesión: `npx firebase-tools login` y volver a correrlo.
- Registro: `~/Library/Logs/cosecoro-avisos.log` (solo dice qué tipo de aviso salió y a cuántos equipos; nunca los textos).
- Parar: `launchctl bootout gui/$(id -u)/com.cosecoro.avisos` (para volver a encenderlo, correr otra vez `instalar.sh`).
- Las llaves y el estado quedan en `~/Library/Application Support/CoseCoro` (`vapid.json` y `avisos-estado.json`). No borrar `vapid.json` ni subirlo al repositorio: si se pierde, cada persona tiene que volver a activar los avisos.
- Si el iMac está apagado o sin internet, estos avisos no salen: al volver solo manda lo de los últimos 10 minutos (lo más viejo no, para no llenar el teléfono de avisos atrasados). Los avisos dentro de la app (campanita, chat) siguen funcionando igual.
- Después de un corte de luz, el programa arranca cuando se entra a la sesión del usuario en el iMac (igual que el medidor). Para que el iMac se encienda solo al volver la luz: Ajustes del Sistema → Energía → «Arrancar automáticamente después de un corte de luz».

## Datos en la nube

- `users/{uid}`: cuenta del trabajador (nombre, cargo, correo, estado, rol). El cargo solo lo cambia un administrador.
- `config/cargos`: lista de cargos.
- `mapa/{zona}` y `mapaLog`: mapa de la tienda y registro de cambios. Solo editan Autoservicio, Inventario y administración.
- Chat: `perfiles`, `conexiones` (solicitudes de compañero), `chats/{id}/mensajes`, `lecturas`. "En línea" en la Realtime Database (`estado/{uid}`).
- Supervisión: solo la cuenta de Rafael puede leer todos los chats, sin escribir en ellos (`supervisor()` en `firestore.rules`).
- Avisos con la app cerrada: `push/{uid}_{equipo}` (cada teléfono que los activó; desde la app nadie los lee) y `config/push` (llave pública, la escribe el iMac).
