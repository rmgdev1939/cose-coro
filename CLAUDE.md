# Notas para trabajar en Cose Coro

- El dueño es Rafael: no es técnico. Respóndele en español, corto y sencillo.
- Es un proyecto personal: no mezclarlo con otros proyectos.
- Toda la app vive en `public/index.html`, un solo archivo con varios bloques `<script>` independientes. El bloque "MODO NUBE (Firebase)" maneja cuentas y mapa; "CHAT DEL EQUIPO" es `window.coseChat`; "EDITOR DEL MAPA" es `window.coseEditor`. Seguir el estilo del archivo: ES5, sin librerías y sin paso de compilación.
- La seguridad la ponen `firestore.rules` y `database.rules.json`, no la app. Cualquier permiso nuevo va en las reglas, con su prueba en `tests/rules.test.mjs`.
- La cuenta supervisora (uid `eabbcqq01NSHmbCiXMMToQIMzU72`, Rafael) está fija en `firestore.rules` (`supervisor()`) y en `index.html` (`SUPERVISOR`). Rafael lo pidió así. Los trabajadores ven un aviso de que la administración puede revisar los chats: no quitarlo.
- Los cargos que editan el mapa (`Autoservicio`, `Inventario`) están en `mapEditor()` de las reglas y en `EDIT_CARGOS` de la app. Si cambian, cambiar los dos.
- Para probar en el navegador sin tocar los datos reales se usa una copia de `index.html` conectada al simulador: `connectAuthEmulator`, `connectFirestoreEmulator` y `connectDatabaseEmulator`, con projectId `demo-cosecoro`. Esa copia no se sube.
- En cada versión: subir `CACHE` en `public/sw.js` y `APP_BUILD` en `index.html` (mismo número), y luego publicar (ver README). `appVersion` se queda en "CC/1.0" hasta que Rafael diga otra.
- Catálogo: `public/catalogo.json` (8.533 productos de coseimpa.com, se rebaja con `node tools/catalogo-bajar.mjs`). `window.coseCatalogo` sugiere lugar en la app (no en Firestore); madera/hierro/mallas/cemento/bloques → `PATIO` (afuera). Lo sugerido pasa al mapa real solo cuando alguien lo confirma o lo arrastra en el Editor.
- Cambios masivos a datos reales: no con la sesión del Firebase CLI (el modo automático lo bloquea); se hacen con un botón de administrador en la app que Rafael toca (ver `runBulk` en el Editor).
- Se publica `dist/`, que arma `tools/publicar/publicar.mjs` (comprime y revuelve el JavaScript; corre solo como predeploy de hosting). Editar siempre `public/`; nunca `dist/`. Si algo falla solo en lo publicado, revisar la compresión.
