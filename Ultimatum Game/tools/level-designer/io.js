/* Level Designer — io.js
 * Loading the game config, and reading/writing the design document on disk.
 */

import { normalize } from "../../web/config.js";
import { emptyDoc } from "./model.js";

export const CONFIG_URL = "/web/config_export.json";
// The doc lives next to the game config, not beside the tool: both are fetched
// from the repo root (serve.py 8790). Pointing this at tools/level-designer/
// silently 404'd, so the boot-time auto-load never worked and only the file
// picker did.
export const DOC_URL = "/web/leveldesign.json";

export const spriteUrl = (id, folder = "Ressources") => (id ? `/web/sprites/${folder}/${id}.png` : "");

// The tool never hardcodes resources: it runs the game's own normalize() over
// the real config_export.json, so adding a resource to the sheet makes it
// appear here with no code change, and the tool can't drift from the engine.
//
// The exporter renames sheets from time to time (upgrades →
// upgrade_machines_profile…). The tool only needs resources, market_config and
// competitors, so sections it never reads are defaulted to [] instead of letting
// normalize() crash — but the gaps are surfaced so a broken *game* isn't hidden.
// `upgrades`/`upgrade_profile` dropped: the game reads the renamed sections
// (upgrade_machines_profile / upgrade_character_profile) with fallback since 2026-07-16.
// "tax" dropped 2026-07-19: the tax feature was cut from the game, normalize() no longer reads it.
const UNUSED_BY_TOOL = ["general", "inputs", "machines", "purshases", "unlock_config", "world_config", "world_level", "rewards", "gears", "characters", "roundIncome", "ressources_tier"];
// These sections no longer live in the sheet at all: the tool generates them
// (they ship to the game as web/config_levels.json). Absent = normal, not a gap.
const GENERATED_BY_TOOL = ["market_config", "competitors_behavior", "competitors_buffs"];

export async function loadGameConfig() {
  const res = await fetch(CONFIG_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`config_export.json: HTTP ${res.status}`);
  const raw = await res.json();
  for (const k of ["resources", "competitors", "customers"]) {
    if (!raw[k]) throw new Error(`config_export.json: section "${k}" absente — le designer ne peut rien faire sans elle.`);
  }
  const missing = UNUSED_BY_TOOL.filter((k) => !raw[k]);
  const defaults = Object.fromEntries([...missing, ...GENERATED_BY_TOOL.filter((k) => !raw[k])].map((k) => [k, []]));
  return { cfg: normalize({ ...defaults, ...raw }), raw, missing };
}

export async function loadDocFromServer() {
  try {
    const res = await fetch(DOC_URL, { cache: "no-store" });
    if (!res.ok) return null;
    return migrate(await res.json());
  } catch { return null; }
}

export function migrate(doc) {
  const d = { ...emptyDoc(), ...doc };
  d.blocks = d.blocks || [];
  d.levels = d.levels || [];
  // v1 docs predate biomes: park every level in a first biome so nothing is lost.
  d.biomes = doc.biomes && doc.biomes.length ? doc.biomes : emptyDoc().biomes;
  const known = new Set(d.biomes.map((b) => b.id));
  d.levels.forEach((l) => {
    if (!l.biomeId || !known.has(l.biomeId)) l.biomeId = d.biomes[0].id;
    // A level's market used to carry its own id, free to drift from the level's on
    // rename — which silently shipped the market under a dead name and loaded the
    // level with 0 rounds. One id now; drop the old field so it can't come back.
    delete l.marketConfigId;
    // pre-per-wave bots stored a flat purchaseWeight and no buffs
    (l.competitors || []).forEach((c) => {
      if (typeof c.purchaseWeight === "number" && !c.purchase) { c.purchase = { mode: "const", value: c.purchaseWeight }; delete c.purchaseWeight; }
      c.purchase = c.purchase || { mode: "const", value: 5 };
      c.buffs = c.buffs || {};
      c.autoMerge = c.autoMerge !== false; // pre-merge docs: bots merge by default
    });
  });
  return d;
}

// ---------- File System Access: write straight into the repo ----------
export const canUseFS = () => typeof window.showSaveFilePicker === "function";

let handle = null;
export const hasHandle = () => !!handle;

export async function pickDocFile(mode) {
  const opts = { types: [{ description: "Level design JSON", accept: { "application/json": [".json"] } }], suggestedName: "leveldesign.json" };
  handle = mode === "open" ? (await window.showOpenFilePicker(opts))[0] : await window.showSaveFilePicker(opts);
  return handle;
}

export async function readHandle() {
  if (!handle) return null;
  const f = await handle.getFile();
  const t = await f.text();
  return t.trim() ? migrate(JSON.parse(t)) : emptyDoc();
}

export async function writeHandle(doc) {
  if (!handle) throw new Error("Aucun fichier ouvert");
  const w = await handle.createWritable();
  await w.write(JSON.stringify(doc, null, 2));
  await w.close();
}

export function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

export function pickLocalFile() {
  return new Promise((resolve) => {
    const i = document.createElement("input");
    i.type = "file"; i.accept = ".json,application/json";
    i.onchange = async () => { const f = i.files[0]; resolve(f ? migrate(JSON.parse(await f.text())) : null); };
    i.click();
  });
}
