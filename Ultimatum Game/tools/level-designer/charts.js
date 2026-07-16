/* Level Designer — charts.js
 * Dependency-free SVG charts.
 *
 * Colour is never the only channel here: every small multiple and bar carries a
 * text label (and a sprite), so the aqua slot's sub-3:1 contrast on the light
 * surface is relieved by direct labels, and a table view backs every chart.
 */

const NS = "http://www.w3.org/2000/svg";
const el = (n, a = {}) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); return e; };
export const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : n >= 100 ? Math.round(n) : Math.round(n * 10) / 10);

let tip;
function tooltip() {
  if (!tip) { tip = document.createElement("div"); tip.className = "tip"; document.body.appendChild(tip); }
  return tip;
}
function showTip(html, ev) {
  const t = tooltip();
  t.innerHTML = html; t.style.display = "block";
  const r = t.getBoundingClientRect();
  t.style.left = Math.min(window.innerWidth - r.width - 8, ev.clientX + 12) + "px";
  t.style.top = Math.max(8, ev.clientY - r.height - 12) + "px";
}
export const hideTip = () => { if (tip) tip.style.display = "none"; };

function scaleY(v, max, top, h) { return max <= 0 ? top + h : top + h - (v / max) * h; }

// ------------------------------------------------------------
// Single-series line chart with crosshair + tooltip.
// One series needs no legend — the title names it.
// ------------------------------------------------------------
export function lineChart(host, { values, labels, unit = "", height = 190 }) {
  host.innerHTML = "";
  if (!values.length) return empty(host);
  const W = 900, H = height, L = 52, R = 12, T = 12, B = 26;
  const w = W - L - R, h = H - T - B;
  const max = Math.max(...values, 1) * 1.08;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart" });
  const x = (i) => L + (values.length > 1 ? (i / (values.length - 1)) * w : w / 2);

  ticks(max).forEach((t) => {
    const y = scaleY(t, max, T, h);
    svg.appendChild(el("line", { x1: L, x2: L + w, y1: y, y2: y, class: "grid" }));
    svg.appendChild(el("text", { x: L - 8, y: y + 4, class: "axis", "text-anchor": "end" })).textContent = fmt(t);
  });

  const pts = values.map((v, i) => [x(i), scaleY(v, max, T, h)]);
  svg.appendChild(el("path", { d: `M${L},${T + h} ` + pts.map((p) => `L${p[0]},${p[1]}`).join(" ") + ` L${L + w},${T + h} Z`, class: "area-1" }));
  svg.appendChild(el("path", { d: "M" + pts.map((p) => `${p[0]},${p[1]}`).join(" L"), class: "line-1" }));

  const cross = el("line", { y1: T, y2: T + h, class: "cross", style: "display:none" });
  const dot = el("circle", { r: 4.5, class: "dot-1", style: "display:none" });
  svg.appendChild(cross); svg.appendChild(dot);

  labelEvery(svg, labels, x, T + h + 18);

  svg.appendChild(el("rect", { x: L, y: T, width: w, height: h, fill: "transparent" }))
    .addEventListener("mousemove", (ev) => {
      const b = svg.getBoundingClientRect();
      const i = Math.max(0, Math.min(values.length - 1, Math.round(((ev.clientX - b.left) / b.width * W - L) / (w || 1) * (values.length - 1))));
      cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.style.display = "";
      dot.setAttribute("cx", x(i)); dot.setAttribute("cy", scaleY(values[i], max, T, h)); dot.style.display = "";
      showTip(`<b>${labels[i]}</b><br>${fmt(values[i])} ${unit}`, ev);
    });
  svg.addEventListener("mouseleave", () => { hideTip(); cross.style.display = "none"; dot.style.display = "none"; });
  host.appendChild(svg);
}

// ------------------------------------------------------------
// Small multiples: one mini area per resource, shared y-scale so the panels are
// comparable at a glance. Identity comes from each panel's own sprite + name,
// which is why a single hue is correct here rather than 10 cycled ones.
// ------------------------------------------------------------
export function smallMultiples(host, { items, labels, shareScale = true, unit = "" }) {
  host.innerHTML = "";
  if (!items.length) return empty(host);
  const gmax = Math.max(1, ...items.map((it) => Math.max(...it.values, 0)));
  items.forEach((it) => {
    const max = (shareScale ? gmax : Math.max(1, ...it.values)) * 1.1;
    const card = document.createElement("div"); card.className = "sm";
    const head = document.createElement("div"); head.className = "sm-head";
    if (it.sprite) { const img = document.createElement("img"); img.src = it.sprite; img.alt = ""; head.appendChild(img); }
    const nm = document.createElement("span"); nm.className = "sm-name"; nm.textContent = it.label; head.appendChild(nm);
    const tot = document.createElement("b"); tot.textContent = fmt(it.total); head.appendChild(tot);
    card.appendChild(head);

    const W = 260, H = 64;
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart sm-chart" });
    const x = (i) => (it.values.length > 1 ? (i / (it.values.length - 1)) * W : W / 2);
    const pts = it.values.map((v, i) => [x(i), scaleY(v, max, 4, H - 8)]);
    svg.appendChild(el("path", { d: `M0,${H - 4} ` + pts.map((p) => `L${p[0]},${p[1]}`).join(" ") + ` L${W},${H - 4} Z`, class: "area-1" }));
    svg.appendChild(el("path", { d: "M" + pts.map((p) => `${p[0]},${p[1]}`).join(" L"), class: "line-1" }));
    const dot = el("circle", { r: 4, class: "dot-1", style: "display:none" }); svg.appendChild(dot);
    svg.appendChild(el("rect", { x: 0, y: 0, width: W, height: H, fill: "transparent" }))
      .addEventListener("mousemove", (ev) => {
        const b = svg.getBoundingClientRect();
        const i = Math.max(0, Math.min(it.values.length - 1, Math.round((ev.clientX - b.left) / b.width * (it.values.length - 1))));
        dot.setAttribute("cx", x(i)); dot.setAttribute("cy", scaleY(it.values[i], max, 4, H - 8)); dot.style.display = "";
        showTip(`<b>${it.label}</b> — ${labels[i]}<br>${fmt(it.values[i])} ${unit}`, ev);
      });
    svg.addEventListener("mouseleave", () => { hideTip(); dot.style.display = "none"; });
    card.appendChild(svg);
    host.appendChild(card);
  });
}

// ------------------------------------------------------------
// Horizontal bars — magnitude, so one hue. Values are labelled directly.
// ------------------------------------------------------------
export function barsH(host, { items, unit = "" }) {
  host.innerHTML = "";
  if (!items.length) return empty(host);
  const max = Math.max(...items.map((i) => i.value), 1);
  items.forEach((it) => {
    const row = document.createElement("div"); row.className = "bar-row";
    const lab = document.createElement("div"); lab.className = "bar-lab";
    if (it.sprite) { const img = document.createElement("img"); img.src = it.sprite; img.alt = ""; lab.appendChild(img); }
    lab.appendChild(document.createTextNode(it.label));
    const track = document.createElement("div"); track.className = "bar-track";
    const fill = document.createElement("div"); fill.className = "bar-fill";
    fill.style.width = (it.value / max) * 100 + "%";
    track.appendChild(fill);
    const val = document.createElement("div"); val.className = "bar-val";
    val.textContent = fmt(it.value) + (unit ? " " + unit : "") + (it.pct != null ? `  (${(it.pct * 100).toFixed(1)}%)` : "");
    row.append(lab, track, val);
    row.addEventListener("mousemove", (ev) => showTip(`<b>${it.label}</b><br>${fmt(it.value)} ${unit}`, ev));
    row.addEventListener("mouseleave", hideTip);
    host.appendChild(row);
  });
}

// ------------------------------------------------------------
// Two-series grouped bars (demand share vs bot weight). Legend + direct labels.
// ------------------------------------------------------------
export function groupedBars(host, { categories, series }) {
  host.innerHTML = "";
  if (!categories.length) return empty(host);
  const leg = document.createElement("div"); leg.className = "legend";
  series.forEach((s, i) => {
    const t = document.createElement("span"); t.className = "leg";
    t.innerHTML = `<i class="sw sw-${i + 1}"></i>${s.label}`; leg.appendChild(t);
  });
  host.appendChild(leg);

  const max = Math.max(1, ...series.flatMap((s) => s.values));
  categories.forEach((c, ci) => {
    const row = document.createElement("div"); row.className = "gb-row";
    const lab = document.createElement("div"); lab.className = "bar-lab";
    if (c.sprite) { const img = document.createElement("img"); img.src = c.sprite; img.alt = ""; lab.appendChild(img); }
    lab.appendChild(document.createTextNode(c.label));
    const stack = document.createElement("div"); stack.className = "gb-stack";
    series.forEach((s, si) => {
      const line = document.createElement("div"); line.className = "gb-line";
      const track = document.createElement("div"); track.className = "bar-track";
      const fill = document.createElement("div"); fill.className = `bar-fill f-${si + 1}`;
      fill.style.width = (s.values[ci] / max) * 100 + "%";
      track.appendChild(fill);
      const v = document.createElement("span"); v.className = "gb-val"; v.textContent = s.fmt ? s.fmt(s.values[ci]) : fmt(s.values[ci]);
      line.append(track, v);
      line.addEventListener("mousemove", (ev) => showTip(`<b>${c.label}</b> — ${s.label}<br>${s.fmt ? s.fmt(s.values[ci]) : fmt(s.values[ci])}`, ev));
      line.addEventListener("mouseleave", hideTip);
      stack.appendChild(line);
    });
    row.append(lab, stack);
    host.appendChild(row);
  });
}

function ticks(max) {
  const step = Math.pow(10, Math.floor(Math.log10(max || 1)));
  const s = max / step > 5 ? step * 2 : max / step > 2 ? step : step / 2;
  const out = []; for (let v = 0; v <= max; v += s) out.push(v);
  return out;
}
function labelEvery(svg, labels, x, y) {
  const every = Math.ceil(labels.length / 14);
  labels.forEach((l, i) => {
    if (i % every) return;
    svg.appendChild(el("text", { x: x(i), y, class: "axis", "text-anchor": "middle" })).textContent = l;
  });
}
function empty(host) {
  const d = document.createElement("div"); d.className = "empty";
  d.textContent = "Rien à afficher — ajoute des blocs au niveau.";
  host.appendChild(d);
}
