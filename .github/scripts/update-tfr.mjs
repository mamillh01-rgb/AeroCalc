// Builds tfr.json (active FAA TFRs: shapes + altitudes + times) for aerocalc.org.
// Runs on GitHub Actions every 15 min. The FAA's CDN blocks Cloudflare Workers and its
// responses carry no CORS header, so the site can't fetch TFRs itself — this file can.
import fs from "node:fs";

const OUT = "tfr.json";
const H = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  "Accept": "application/json, text/xml, */*",
  "Referer": "https://tfr.faa.gov/tfr3/?page=map",
};
const notamOf = (v) => { const m = String(v || "").match(/(\d\/\d{4})/); return m ? m[1] : null; };
const round = (g) => JSON.parse(JSON.stringify(g), (k, v) => typeof v === "number" ? Math.round(v * 1e5) / 1e5 : v);

async function get(url, as = "json") {
  const r = await fetch(url, { headers: H });
  if (!r.ok) throw new Error(url + " → HTTP " + r.status);
  return as === "json" ? r.json() : r.text();
}

function parseXml(id, xml) {
  const all = (tag) => { const out = [], re = new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">", "g"); let m; while ((m = re.exec(xml))) out.push(m[1].trim()); return out; };
  const areas = []; const re = /<aseTFRArea[^>]*>([\s\S]*?)<\/aseTFRArea>/g; let m;
  while ((m = re.exec(xml))) {
    const b = m[1], g = (t) => { const x = b.match(new RegExp("<" + t + "[^>]*>([\\s\\S]*?)</" + t + ">")); return x ? x[1].trim() : null; };
    areas.push({ name: g("txtName"), lowerCode: g("codeDistVerLower"), lowerVal: g("valDistVerLower"), upperCode: g("codeDistVerUpper"), upperVal: g("valDistVerUpper") });
  }
  if (!areas.length && !all("dateEffective").length) return null;
  return { areas, effective: all("dateEffective"), expire: all("dateExpire"), purpose: all("txtDescrPurpose")[0] || null,
    link: "https://tfr.faa.gov/tfr3/?page=detail_" + id.replace("/", "_") };
}

const prev = (() => { try { return JSON.parse(fs.readFileSync(OUT, "utf8")); } catch { return null; } })();
const prevDetail = {};
(prev?.features || []).forEach((f) => { const p = f.properties || {}; if (p.notam && p.detail) prevDetail[p.notam + "|" + (p.mod || "")] = p.detail; });

const list = await get("https://tfr.faa.gov/tfrapi/getTfrList");
const shapes = await get("https://tfr.faa.gov/geoserver/TFR/ows?service=WFS&version=1.1.0&request=GetFeature&typeName=TFR:V_TFR_LOC&outputFormat=application/json&srsname=EPSG:4326");
if (!Array.isArray(list) || !list.length || !shapes?.features?.length) throw new Error("FAA returned no TFRs — keeping the previous file");

const byId = {};
list.forEach((t) => { const id = notamOf(t.notam_id || t.gid); if (id) byId[id] = t; });

const features = [];
let detailOk = 0, detailFail = 0;
for (const f of shapes.features) {
  if (!f?.geometry) continue;
  const p = f.properties || {}, id = notamOf(p.NOTAM_KEY) || notamOf(f.id);
  const meta = id && byId[id];
  if (!meta) continue; // shape of a TFR that is no longer active
  const mod = meta.mod_abs_time || meta.mod_date || "";
  let detail = prevDetail[id + "|" + mod] || null;
  if (!detail) {
    const slug = id.replace("/", "_");
    for (const u of ["https://tfr.faa.gov/download/detail_" + slug + ".xml", "https://tfr.faa.gov/save_pages/detail_" + slug + ".xml"]) {
      try { detail = parseXml(id, await get(u, "text")); if (detail) break; } catch {}
    }
    detail ? detailOk++ : detailFail++;
  }
  features.push({ type: "Feature", geometry: round(f.geometry), properties: {
    notam: id, type: meta.type || p.LEGAL || "", title: meta.description || p.TITLE || "",
    state: meta.state || p.STATE || "", facility: meta.facility || p.CNS_LOCATION_ID || "", mod, detail } });
}
features.sort((a, b) => String(a.properties.notam).localeCompare(String(b.properties.notam)));

const body = { source: "FAA", features };
const sameAsBefore = prev && JSON.stringify({ source: prev.source, features: prev.features }) === JSON.stringify(body);
if (sameAsBefore) { console.log("No TFR changes (" + features.length + " active)"); process.exit(0); }
fs.writeFileSync(OUT, JSON.stringify({ ...body, updated: new Date().toISOString() }));
console.log("Wrote " + features.length + " TFRs (details: " + detailOk + " fetched, " + detailFail + " unavailable)");
