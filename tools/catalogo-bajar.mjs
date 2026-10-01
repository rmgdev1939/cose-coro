// Baja el catálogo público de coseimpa.com (WooCommerce Store API) a catalogo.json.
// Solo lectura, de 100 en 100, con una pausa corta entre páginas.
import fs from "node:fs";
const BASE = "https://coseimpa.com/wp-json/wc/store/products";
const out = [];
let page = 1, pages = 1;
const dec = s => String(s || "").replace(/&amp;/g, "&").replace(/&#8217;/g, "’").replace(/&#8211;/g, "–").replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n));
while (page <= pages) {
  let r, tries = 0;
  for (;;) {
    try { r = await fetch(`${BASE}?per_page=100&page=${page}&orderby=id&order=asc`, { headers: { "User-Agent": "CoseCoro-catalogo/1.0" } }); if (r.ok) break; throw new Error("HTTP " + r.status); }
    catch (e) { if (++tries > 4) throw e; await new Promise(s => setTimeout(s, 2000 * tries)); }
  }
  pages = +r.headers.get("x-wp-totalpages") || pages;
  const list = await r.json();
  for (const p of list) out.push({ id: p.id, nombre: dec(p.name), sku: p.sku || "", categorias: (p.categories || []).map(c => dec(c.name)), url: p.permalink, enStock: !!p.is_in_stock });
  if (page % 10 === 0 || page === pages) console.log(`página ${page}/${pages} · ${out.length} productos`);
  page++;
  await new Promise(s => setTimeout(s, 300));
}
fs.writeFileSync("catalogo.json", JSON.stringify({ fuente: BASE, fecha: new Date().toISOString(), total: out.length, productos: out }, null, 1));
const cats = {};
out.forEach(p => (p.categorias.length ? p.categorias : ["(sin categoría)"]).forEach(c => { cats[c] = (cats[c] || 0) + 1; }));
fs.writeFileSync("categorias.json", JSON.stringify(Object.entries(cats).sort((a, b) => b[1] - a[1]), null, 1));
console.log("TOTAL", out.length, "· categorías", Object.keys(cats).length);
