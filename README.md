# Cose Coro

App (PWA) para el personal de la sucursal Coro de Coseimpa: calculadoras de materiales, mapa de la tienda, tasa BCV, cuentas de trabajadores, chat del equipo y editor del mapa.

- En vivo: https://cosecoro-coro.web.app
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
| `tests/` | Pruebas de las reglas de seguridad |
| `tools/monitor.cjs` | Medidor del plan gratis: guarda el consumo en `monitor/resumen` para la pantalla "Estado del sistema". Corre cada hora en la computadora de Rafael (`tools/com.cosecoro.monitor.plist`, instalado desde una copia en `~/Library/Application Support/CoseCoro`) |

## Publicar

```bash
npx -y firebase-tools@14 deploy --only hosting,firestore:rules,database
```

Antes de publicar: subir la versión en `public/index.html` (`appVersion`) y en `public/sw.js` (`CACHE`).

## Probar las reglas de seguridad

Necesita Java 11 o más nuevo (lo usa el simulador de Firebase).

```bash
cd tests && npm install && npm test
```

## Datos en la nube

- `users/{uid}`: cuenta del trabajador (nombre, cargo, correo, estado, rol). El cargo solo lo cambia un administrador.
- `config/cargos`: lista de cargos.
- `mapa/{zona}` y `mapaLog`: mapa de la tienda y registro de cambios. Solo editan Autoservicio, Inventario y administración.
- Chat: `perfiles`, `conexiones` (solicitudes de compañero), `chats/{id}/mensajes`, `lecturas`. "En línea" en la Realtime Database (`estado/{uid}`).
- Supervisión: solo la cuenta de Rafael puede leer todos los chats, sin escribir en ellos (`supervisor()` en `firestore.rules`).
