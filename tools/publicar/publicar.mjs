// Cose Coro · arma dist/ (lo que se publica en Firebase Hosting) a partir de public/.
// El código fuente sigue legible en public/ (y en GitHub, privado); lo publicado
// lleva el JavaScript comprimido y con los nombres revueltos, para que copiarlo y
// entenderlo cueste mucho más. No cambia nada para los usuarios.
// Corre solo antes de cada `firebase deploy --only hosting` (predeploy en firebase.json).
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const AQUI = path.dirname(new URL(import.meta.url).pathname);
const RAIZ = path.resolve(AQUI, "../..");
const SRC = path.join(RAIZ, "public"), DST = path.join(RAIZ, "dist");
if (!fs.existsSync(path.join(AQUI, "node_modules/terser"))) execSync("npm install --silent", { cwd: AQUI, stdio: "inherit" });
const { minify } = await import(path.join(AQUI, "node_modules/terser/main.js"));

const AVISO = "Cose Coro © 2026 Rafael Morín. Todos los derechos reservados. Prohibida su copia, modificación o uso sin autorización escrita.";

fs.rmSync(DST, { recursive: true, force: true });
fs.cpSync(SRC, DST, { recursive: true });

const html = fs.readFileSync(path.join(SRC, "index.html"), "utf8");
const partes = html.split(/(<script>[\s\S]*?<\/script>)/);
let antes = 0, despues = 0, n = 0;
for (let i = 0; i < partes.length; i++) {
  const m = /^<script>([\s\S]*?)<\/script>$/.exec(partes[i]);
  if (!m) continue;
  const r = await minify(m[1], {
    ecma: 5, safari10: true,
    compress: { passes: 2, drop_debugger: true },
    mangle: true,               // solo nombres internos; los globales (window.cose…) no se tocan
    format: { comments: false, ascii_only: false },
  });
  if (!r.code) throw new Error("no se pudo comprimir el bloque " + n);
  antes += m[1].length; despues += r.code.length; n++;
  partes[i] = "<script>" + r.code + "</script>";
}
let out = partes.join("");
out = out.replace(/<!--(?![\s\S]*?\[if)[\s\S]*?-->/g, "");      // sin comentarios HTML
out = out.replace(/^(<!DOCTYPE html>)/i, `$1\n<!-- ${AVISO} -->`);
fs.writeFileSync(path.join(DST, "index.html"), out);
for (const f of ["sw.js"]) {
  const p = path.join(DST, f);
  fs.writeFileSync(p, `/* ${AVISO} */\n` + fs.readFileSync(p, "utf8"));
}
console.log(`publicar: ${n} bloques de JavaScript, ${Math.round(antes / 1024)} KB → ${Math.round(despues / 1024)} KB. Listo en dist/.`);
