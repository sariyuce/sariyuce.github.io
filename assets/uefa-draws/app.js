// European football match-up graph viewer.
// No-build single-page app. Cytoscape + cose-bilkent loaded from esm.sh.

import cytoscape from "https://esm.sh/cytoscape@3.30.4";
import cola from "https://esm.sh/cytoscape-cola@2.5.1";
import cise from "https://esm.sh/cytoscape-cise@1.0.0";
import {
  forceSimulation, forceLink, forceManyBody,
  forceCollide, forceCenter,
} from "https://esm.sh/d3-force@3.0.0";

cytoscape.use(cola);
cytoscape.use(cise);

// ---------- Dataset registry ----------
// Add new datasets by dropping a JSON in /datasets and an entry here.
const DATASETS = [
  { id: "ucl-26-27",  name: "Champions League 26-27",  path: "datasets/ucl-26-27.json" },
  { id: "uel-26-27",  name: "Europa League 26-27",     path: "datasets/uel-26-27.json" },
  { id: "uecl-26-27", name: "Conference League 26-27", path: "datasets/uecl-26-27.json" },
  { id: "ucl-25-26",  name: "Champions League 25-26",  path: "datasets/ucl-25-26.json" },
  { id: "uel-25-26",  name: "Europa League 25-26",     path: "datasets/uel-25-26.json" },
  { id: "uecl-25-26", name: "Conference League 25-26", path: "datasets/uecl-25-26.json" },
  { id: "ucl-24-25",  name: "Champions League 24-25",  path: "datasets/ucl-24-25.json" },
  { id: "uel-24-25",  name: "Europa League 24-25",     path: "datasets/uel-24-25.json" },
];

// ---------- Visual encoding tables ----------
// 16 country colors, hand-picked for distinguishability. The biggest national
// contingents get the boldest, most-saturated hues; single-team countries get
// remaining slots in the palette.
//   ENG(6) red · ESP(5) mustard · ITA(4) navy · GER(4) charcoal
//   FRA(3) purple · NED(2) orange · POR(2) forest · BEL(2) magenta
//   then 8 single-team countries.
const COUNTRY_COLOR = {
  ENG: "#dc2626", // England — 6 teams
  ESP: "#ca8a04", // Spain — 5
  ITA: "#1e40af", // Italy — 4
  GER: "#1f2937", // Germany — 4
  FRA: "#7c3aed", // France — 3
  NED: "#ea580c", // Netherlands — 2
  POR: "#15803d", // Portugal — 2
  BEL: "#c026d3", // Belgium — 2
  NOR: "#fbbf24", // Norway
  DEN: "#be123c", // Denmark
  TUR: "#84cc16", // Turkey
  GRE: "#06b6d4", // Greece
  CYP: "#a16207", // Cyprus
  CZE: "#6366f1", // Czechia
  AZE: "#14b8a6", // Azerbaijan
  KAZ: "#ef4444", // Kazakhstan
};

// Pot is encoded via border *style* (not color), so country and pot can both
// be read at a glance: country = border color, pot = border line style.
const POT_STYLE = {
  1: "solid",   // top tier — solid (cleanest)
  2: "dashed",
  3: "dotted",
  4: "double",
};

const RESULT_COLOR = {
  H: "#3eaf6b", // home win — green
  D: "#9aa0a6", // draw — neutral grey
  A: "#e25c5c", // away win — red
};

// ---------- DOM helpers ----------
const $ = (id) => document.getElementById(id);
const datasetSelect = $("datasetSelect");
const layoutSelect = $("layoutSelect");
const countryHighlight = $("countryHighlight");
const clusterHighlight = $("clusterHighlight");
const showAllClusters = $("showAllClusters");
const clusterControls = $("clusterControls");
const showEdgeLabels = $("showEdgeLabels");
const colorEdges = $("colorEdges");
const focusSelected = $("focusSelected");
const showLogos = $("showLogos");

// ---------- App state ----------
let cy = null;
let dataset = null;
let savedPositionsKey = null;  // localStorage key for current dataset

// ---------- Load + render dataset ----------
// Cache-bust every fetch so browsers don't serve stale dataset JSONs whose
// logo URLs still point at Wikipedia. Bump this string when data changes.
const DATA_VERSION = "20260830c";

async function loadDataset(id) {
  const def = DATASETS.find((d) => d.id === id);
  const resp = await fetch(`${def.path}?v=${DATA_VERSION}`);
  if (!resp.ok) throw new Error(`Failed to load ${def.path}: ${resp.status}`);
  dataset = await resp.json();
  savedPositionsKey = `vis:positions:${dataset.id}`;
  // Datasets whose season hasn't kicked off yet carry null goals on every
  // edge. Score-driven and direction-driven edge toggles are meaningless
  // there, so we disable and uncheck them.
  const hasAnyScore = dataset.edges.some(
    (e) => e.homeGoals != null && e.awayGoals != null,
  );
  for (const ctrl of [showEdgeLabels, colorEdges]) {
    ctrl.disabled = !hasAnyScore;
    if (!hasAnyScore) ctrl.checked = false;
  }
  $("datasetMeta").textContent =
    `${dataset.competition} · ${dataset.season} · ${dataset.phase} · ` +
    `${dataset.nodes.length} teams, ${dataset.edges.length} matches` +
    (hasAnyScore ? "" : " (season not yet played)");
  buildCountryHighlightDropdown();
  buildClusterHighlightDropdown();
  buildLegend();
  render();
}

function representativeClusters(clusters) {
  // Greedy max-coverage: repeatedly pick the cluster that adds the most NEW
  // teams to the running covered set. Ties broken by preferring clusters whose
  // members are rarest across the cluster list (i.e. clusters with distinctive
  // team mixes). Stops once no cluster adds a new team.
  if (!clusters || clusters.length === 0) return [];
  const teamFreq = new Map();
  for (const c of clusters) for (const t of c) teamFreq.set(t, (teamFreq.get(t) || 0) + 1);
  const rarity = (cluster) =>
    cluster.reduce((s, t) => s + (teamFreq.get(t) || 0), 0);

  const remaining = clusters.map((c, i) => ({ i, set: new Set(c), score: rarity(c) }));
  const covered = new Set();
  const picked = [];
  while (remaining.length > 0) {
    let best = -1, bestNew = 0, bestScore = Infinity;
    for (let k = 0; k < remaining.length; k++) {
      const c = remaining[k];
      let nu = 0;
      for (const t of c.set) if (!covered.has(t)) nu++;
      if (nu > bestNew || (nu === bestNew && c.score < bestScore)) {
        best = k; bestNew = nu; bestScore = c.score;
      }
    }
    if (best === -1 || bestNew === 0) break;
    const chosen = remaining.splice(best, 1)[0];
    for (const t of chosen.set) covered.add(t);
    picked.push(chosen.i);
  }
  return picked;
}

function clusterOptionLabel(index, cluster) {
  const labels = cluster.map((slug) => {
    const node = dataset.nodes.find((n) => n.id === slug);
    return node ? node.label : slug;
  });
  return `#${index + 1} · ${labels.join(", ")}`;
}

function buildClusterHighlightDropdown() {
  const clusters = dataset.clusters || [];
  if (clusters.length === 0) {
    clusterControls.style.display = "none";
    return;
  }
  clusterControls.style.display = "";
  const indices = showAllClusters.checked
    ? clusters.map((_, i) => i)
    : representativeClusters(clusters);
  clusterHighlight.innerHTML = '<option value="">(none — show all)</option>';
  for (const i of indices) {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = clusterOptionLabel(i, clusters[i]);
    clusterHighlight.appendChild(opt);
  }
}

function buildCountryHighlightDropdown() {
  // Options sorted by team count desc, then alphabetically.
  const counts = new Map();
  for (const n of dataset.nodes) {
    counts.set(n.country, (counts.get(n.country) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  countryHighlight.innerHTML = '<option value="">(none — show all)</option>';
  for (const [country, n] of sorted) {
    const opt = document.createElement("option");
    opt.value = country;
    opt.textContent = `${country} (${n})`;
    countryHighlight.appendChild(opt);
  }
}

function buildLegend() {
  const body = $("legendBody");
  // Sort countries by team count desc so the legend matches the dropdown order.
  const counts = new Map();
  const codeFor = new Map(); // country name -> ISO-ish code
  for (const n of dataset.nodes) {
    counts.set(n.country, (counts.get(n.country) || 0) + 1);
    codeFor.set(n.country, n.countryCode);
  }
  const sorted = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  const lines = [];
  lines.push(`<div class="muted">Countries (#teams)</div>`);
  for (const [country, count] of sorted) {
    const code = codeFor.get(country);
    lines.push(
      `<div class="legendRow"><span class="legendSwatch" style="background:${COUNTRY_COLOR[code] || "#666"}"></span>${country} (${count})</div>`,
    );
  }
  lines.push(`<div class="muted" style="margin-top:6px">Pot (border style)</div>`);
  for (const p of [1, 2, 3, 4]) {
    lines.push(
      `<div class="legendRow"><span class="legendBorder ${POT_STYLE[p]}"></span>Pot ${p}</div>`,
    );
  }
  lines.push(`<div class="muted" style="margin-top:6px">Edge result (home POV)</div>`);
  for (const [k, label] of [["H", "Home win"], ["D", "Draw"], ["A", "Away win"]]) {
    lines.push(
      `<div class="legendRow"><span class="legendSwatch" style="background:${RESULT_COLOR[k]}"></span>${label}</div>`,
    );
  }
  body.innerHTML = lines.join("");
}

// ---------- Build Cytoscape elements + style ----------
function nodesToCy(savedPositions) {
  return dataset.nodes.map((n) => {
    const raw = n.logo || "";
    // Append cache-bust so a browser holding an old cached logo URL still
    // triggers a fresh fetch.
    const logo = raw ? `${raw}?v=${DATA_VERSION}` : "";
    return {
      group: "nodes",
      data: {
        id: n.id,
        label: n.label,
        country: n.country,
        countryCode: n.countryCode,
        pot: n.pot,
        logo,
        hasLogo: logo ? "yes" : "no",
        countryColor: COUNTRY_COLOR[n.countryCode] || "#666",
        potStyle: POT_STYLE[n.pot] || "solid",
      },
      position: savedPositions?.[n.id],
    };
  });
}

function edgesToCy() {
  return dataset.edges.map((e) => {
    const hasScore = e.homeGoals != null && e.awayGoals != null;
    const result = hasScore
      ? (e.homeGoals > e.awayGoals ? "H" : e.homeGoals < e.awayGoals ? "A" : "D")
      : "?";
    const goalDiff = hasScore ? Math.abs(e.homeGoals - e.awayGoals) : 0;
    return {
      group: "edges",
      data: {
        id: e.id,
        source: e.source,
        target: e.target,
        round: e.round,
        homeGoals: e.homeGoals,
        awayGoals: e.awayGoals,
        result,
        goalDiff,
        scoreLabel: hasScore ? `${e.homeGoals}–${e.awayGoals}` : "",
        resultColor: RESULT_COLOR[result] || "#8a90a0",
      },
    };
  });
}

function styleSheet() {
  // Country = border color, pot = border line style. Both always visible.
  // Logos toggle controls fill (white when on, neutral dark when off).
  const baseNode = {
    shape: "ellipse",
    width: 58,
    height: 58,
    label: "data(label)",
    color: "#e6e8ee",
    "font-size": 10,
    "font-weight": 600,
    "text-valign": "bottom",
    "text-halign": "center",
    "text-margin-y": 4,
    "text-wrap": "wrap",
    "text-max-width": 84,
    "text-outline-color": "#0f1115",
    "text-outline-width": 2,
    "border-color": "data(countryColor)",
    "border-style": "data(potStyle)",
    "border-width": 3,
    "background-color": showLogos.checked ? "#ffffff" : "data(countryColor)",
  };
  // Only nodes that carry a logo URL get the background-image rule below.
  // Empty logo strings crash cytoscape's style parser, so we gate on hasLogo.
  const logoNodeStyle = showLogos.checked ? {
    "background-image": "data(logo)",
    "background-fit": "contain",
    "background-image-opacity": 1,
  } : null;

  // Edge styling depends on whether color/direction is enabled.
  const edgeColored = colorEdges.checked;
  const edgeStyle = {
    width: 2,
    "curve-style": "bezier",
    "control-point-step-size": 30,
    opacity: 0.85,
    "line-color": edgeColored ? "data(resultColor)" : "#888",
    "target-arrow-color": edgeColored ? "data(resultColor)" : "#888",
    "target-arrow-shape": edgeColored ? "triangle" : "none",
    "arrow-scale": 0.9,
    label: showEdgeLabels.checked ? "data(scoreLabel)" : "",
    "font-size": 9,
    color: "#0f1115",
    "text-background-color": "#fff",
    "text-background-opacity": 0.85,
    "text-background-padding": 1,
    "text-rotation": "autorotate",
  };

  return [
    { selector: "node", style: baseNode },
    ...(logoNodeStyle ? [{ selector: 'node[hasLogo = "yes"]', style: logoNodeStyle }] : []),
    {
      selector: "node:selected",
      style: { "border-color": "#5cc8ff", "border-width": 5 },
    },
    {
      selector: "edge",
      style: edgeStyle,
    },
    {
      selector: "edge:selected",
      style: { width: 5, opacity: 1 },
    },
    {
      selector: "edge.cluster-edge",
      style: { width: 5, opacity: 1 },
    },
    {
      selector: ".dim",
      style: { opacity: 0.08 },
    },
  ];
}

// ---------- Layouts ----------
function circleByAttrPositions(attr) {
  // Sort nodes by the chosen attribute, then label, and place them on a single
  // ring in that order. Insert a one-slot gap between each group so the
  // grouping is visually obvious. Radius scales with slot count so adjacent
  // nodes and their labels don't overlap; targets ~100 px of arc per slot.
  const sorted = [...dataset.nodes].sort((a, b) => {
    const av = String(a[attr]), bv = String(b[attr]);
    if (av !== bv) return av.localeCompare(bv, undefined, { numeric: true });
    return a.label.localeCompare(b.label);
  });
  const N = sorted.length;
  const G = new Set(sorted.map((n) => n[attr])).size;
  const totalSlots = N + G;
  const arcPerSlot = 100;                        // px between adjacent slots along the ring
  const radius = Math.max(300, (arcPerSlot * totalSlots) / (2 * Math.PI));
  const slotAngle = (2 * Math.PI) / totalSlots;

  const positions = {};
  let slot = 0, prevAttr = null;
  for (const n of sorted) {
    if (prevAttr !== null && n[attr] !== prevAttr) slot += 1; // gap between groups
    const theta = slot * slotAngle - Math.PI / 2;
    positions[n.id] = { x: radius * Math.cos(theta), y: radius * Math.sin(theta) };
    slot += 1;
    prevAttr = n[attr];
  }
  return positions;
}

function groupBy(attr) {
  // -> array of arrays of node ids, one per distinct value of `attr`
  const groups = new Map();
  for (const n of dataset.nodes) {
    const k = n[attr];
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(n.id);
  }
  return [...groups.values()];
}

function radialByClusterDensityPositions(attr) {
  // Group nodes by `attr`, then place each group on a spiral whose radius
  // grows with rank-by-intra-cluster-edge-count. Densest group ends up at
  // the center, sparsest at the rim. Within each group, nodes sit on a small
  // circle around the group center so the cluster reads as a unit.
  const groups = new Map();
  for (const n of dataset.nodes) {
    const k = n[attr];
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(n.id);
  }
  const arr = [...groups.entries()].map(([key, ids]) => {
    const s = new Set(ids);
    const intra = dataset.edges.filter(
      (e) => s.has(e.source) && s.has(e.target),
    ).length;
    return { key, ids, intra, size: ids.length };
  });
  // Densest first; tie-break by group size (bigger groups inward).
  arr.sort((a, b) => b.intra - a.intra || b.size - a.size);

  const positions = {};
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const baseR = 70;
  const stepR = 95;
  arr.forEach((g, i) => {
    const r = i === 0 ? 0 : baseR + stepR * Math.sqrt(i);
    const theta = i * goldenAngle;
    const cx = r * Math.cos(theta);
    const cy = r * Math.sin(theta);
    const ringR = g.size === 1 ? 0 : 22 + 10 * g.size;
    g.ids.forEach((nid, j) => {
      const a = (2 * Math.PI / g.size) * j - Math.PI / 2;
      positions[nid] = {
        x: cx + ringR * Math.cos(a),
        y: cy + ringR * Math.sin(a),
      };
    });
  });
  return positions;
}

function coClusterPositions(opts = {}) {
  // d3-force simulation where co-cluster pairs attract by spring (strength
  // scales with shared-cluster count) and all pairs repel via charge.
  // Two knobs: edgeLengthScale multiplies the spring rest length; repulsionScale
  // multiplies the charge magnitude (lower → tighter overall layout, peripheral
  // nodes drift less).
  const edgeLengthScale = opts.edgeLengthScale ?? 1.0;
  const repulsionScale = opts.repulsionScale ?? 1.0;

  const clusters = dataset.clusters || [];
  const ids = dataset.nodes.map((n) => n.id);
  const present = new Set(ids);

  const w = new Map();
  for (const cluster of clusters) {
    for (let i = 0; i < cluster.length; i++) {
      for (let j = i + 1; j < cluster.length; j++) {
        let a = cluster[i], b = cluster[j];
        if (!present.has(a) || !present.has(b)) continue;
        if (a > b) [a, b] = [b, a];
        const key = `${a}|${b}`;
        w.set(key, (w.get(key) || 0) + 1);
      }
    }
  }
  const nodes = ids.map((id) => ({ id }));
  const links = [...w.entries()].map(([k, weight]) => {
    const [s, t] = k.split("|");
    return { source: s, target: t, weight };
  });

  const sim = forceSimulation(nodes)
    .force(
      "link",
      forceLink(links)
        .id((d) => d.id)
        .distance((l) => edgeLengthScale * Math.max(35, 200 / Math.sqrt(l.weight)))
        .strength((l) => Math.min(1, 0.15 * l.weight)),
    )
    .force("charge", forceManyBody().strength(-280 * repulsionScale))
    .force("center", forceCenter(0, 0))
    .force("collide", forceCollide(38))
    .stop();

  for (let i = 0; i < 500; i++) sim.tick();

  const positions = {};
  for (const n of nodes) positions[n.id] = { x: n.x * 2.5, y: n.y * 2.5 };
  return positions;
}

function ciseLayout(clusters) {
  return {
    name: "cise",
    clusters,
    animate: "end",
    animationDuration: 700,
    refresh: 10,
    fit: true,
    padding: 40,
    nodeSeparation: 18,
    idealInterClusterEdgeLengthCoefficient: 1.6,
    allowNodesInsideCircle: false,
    maxRatioOfNodesInsideCircle: 0.1,
    springCoeff: 0.45,
    nodeRepulsion: 4500,
    gravity: 0.25,
    gravityRange: 3.8,
  };
}

function layoutOptions(name) {
  switch (name) {
    case "concentric-pot":
      return {
        name: "concentric",
        concentric: (node) => 5 - node.data("pot"), // pot 1 -> innermost
        levelWidth: () => 1,
        spacingFactor: 1.4,
        minNodeSpacing: 24,
        animate: true,
        animationDuration: 400,
      };
    case "circle-country":
      return {
        name: "preset",
        positions: circleByAttrPositions("country"),
        animate: true,
        animationDuration: 400,
        fit: true,
        padding: 40,
      };
    case "circle-pot":
      return {
        name: "preset",
        positions: circleByAttrPositions("pot"),
        animate: true,
        animationDuration: 400,
        fit: true,
        padding: 40,
      };
    case "cola":
      return {
        name: "cola",
        animate: true,
        refresh: 1,
        maxSimulationTime: 4000,
        ungrabifyWhileSimulating: false,
        fit: true,
        padding: 30,
        randomize: true,
        avoidOverlap: true,
        handleDisconnected: true,
        convergenceThreshold: 0.01,
        nodeSpacing: () => 30,
        edgeLength: 140,
      };
    case "cise-pot":
      return ciseLayout(groupBy("pot"));
    case "cise-country":
      return ciseLayout(groupBy("country"));
    case "radial-country":
      return {
        name: "preset",
        positions: radialByClusterDensityPositions("country"),
        animate: true,
        animationDuration: 500,
        fit: true,
        padding: 40,
      };
    case "cocluster":
      return {
        name: "preset",
        positions: coClusterPositions({
          edgeLengthScale: Number($("edgeLength").value),
          repulsionScale: Number($("repulsion").value),
        }),
        animate: true,
        animationDuration: 500,
        fit: true,
        padding: 40,
      };
    case "grid":
      return { name: "grid", animate: true, animationDuration: 300 };
    case "preset":
      return { name: "preset", animate: false };
    default:
      return { name: "grid" };
  }
}

// ---------- Render / re-render ----------
function loadSavedPositions() {
  if (!savedPositionsKey) return null;
  try {
    return JSON.parse(localStorage.getItem(savedPositionsKey) || "null");
  } catch {
    return null;
  }
}

function render() {
  if (cy) cy.destroy();
  const saved = loadSavedPositions();
  const initialLayout = layoutSelect.value;

  cy = cytoscape({
    container: $("cy"),
    elements: [
      ...nodesToCy(initialLayout === "preset" ? saved : null),
      ...edgesToCy(),
    ],
    style: styleSheet(),
    wheelSensitivity: 0.2,
    minZoom: 0.3,
    maxZoom: 3,
    layout: layoutOptions(initialLayout),
  });

  cy.on("tap", "node", (ev) => showNodeInfo(ev.target));
  cy.on("tap", "edge", (ev) => showEdgeInfo(ev.target));
  cy.on("tap", (ev) => {
    if (ev.target === cy) {
      $("info").textContent = "Click a node or edge for details.";
      applyHighlight();
    }
  });

  applyHighlight();
}

function applyHighlight() {
  // Priority of highlight modes:
  //   1) a cluster is selected → dim non-cluster; thicken cluster's match edges
  //   2) a country is selected → dim non-country; keep country teams bright
  //   3) focus-selected toggle + a selected node → dim outside the neighborhood
  //   4) otherwise → clear all dimming
  // Country and cluster selection are mutually exclusive (enforced at the
  // dropdown change listeners).
  if (!cy) return;
  cy.batch(() => {
    cy.elements().removeClass("dim cluster-edge");

    const clusterIdx = clusterHighlight.value;
    if (clusterIdx !== "") {
      const cluster = dataset.clusters?.[Number(clusterIdx)];
      if (!cluster || cluster.length === 0) return;
      const ids = new Set(cluster);
      const inCluster = cy.nodes().filter((n) => ids.has(n.id()));
      if (inCluster.length === 0) return;
      cy.elements().addClass("dim");
      inCluster.removeClass("dim");
      const intraEdges = cy.edges().filter(
        (e) => ids.has(e.source().id()) && ids.has(e.target().id()),
      );
      intraEdges.removeClass("dim");
      intraEdges.addClass("cluster-edge");
      return;
    }

    const country = countryHighlight.value;
    if (country) {
      const inCountry = cy.nodes().filter((n) => n.data("country") === country);
      if (inCountry.length === 0) return;
      cy.elements().addClass("dim");
      inCountry.removeClass("dim");
      inCountry.connectedEdges().removeClass("dim");
      return;
    }

    if (focusSelected.checked) {
      const sel = cy.$("node:selected");
      if (sel.length) {
        cy.elements().addClass("dim");
        sel.closedNeighborhood().removeClass("dim");
      }
    }
  });
}

function showNodeInfo(node) {
  const d = node.data();
  const opp = node.connectedEdges();
  const scored = opp.filter((e) => e.data("result") !== "?");
  const wins = scored.filter((e) => {
    if (e.source().id() === node.id()) return e.data("result") === "H";
    return e.data("result") === "A";
  }).length;
  const draws = scored.filter((e) => e.data("result") === "D").length;
  const losses = scored.length - wins - draws;
  const record = scored.length
    ? `${opp.length} matches — ${wins}W ${draws}D ${losses}L`
    : `${opp.length} matches (no scores)`;
  $("info").textContent =
    `${d.label}\n${d.country} · Pot ${d.pot}\n` + record;
  applyHighlight();
}

function showEdgeInfo(edge) {
  const d = edge.data();
  const home = cy.getElementById(d.source).data("label");
  const away = cy.getElementById(d.target).data("label");
  const label = dataset.meta?.roundLabel || "Round";
  const hasScore = d.homeGoals != null && d.awayGoals != null;
  const header = d.round != null ? `${label} ${d.round}\n` : "";
  const body = hasScore
    ? `${home}  ${d.homeGoals} – ${d.awayGoals}  ${away}`
    : `${home}  vs  ${away}`;
  $("info").textContent = header + body;
}

// ---------- Wire up controls ----------
function init() {
  for (const d of DATASETS) {
    const opt = document.createElement("option");
    opt.value = d.id;
    opt.textContent = d.name;
    datasetSelect.appendChild(opt);
  }
  datasetSelect.value = DATASETS[0].id;

  datasetSelect.addEventListener("change", () => loadDataset(datasetSelect.value));

  layoutSelect.addEventListener("change", () => {
    if (!cy) return;
    cy.layout(layoutOptions(layoutSelect.value)).run();
    $("coclusterTuning").style.display =
      layoutSelect.value === "cocluster" ? "" : "none";
  });

  // Re-run cocluster layout when tuning sliders change.
  for (const id of ["edgeLength", "repulsion"]) {
    const input = $(id);
    const out = $(id + "Val");
    input.addEventListener("input", () => {
      out.textContent = Number(input.value).toFixed(1);
    });
    input.addEventListener("change", () => {
      if (!cy || layoutSelect.value !== "cocluster") return;
      cy.layout(layoutOptions("cocluster")).run();
    });
  }

  for (const ctrl of [showEdgeLabels, colorEdges, showLogos]) {
    ctrl.addEventListener("change", () => {
      if (!cy) return;
      cy.style(styleSheet()).update();
    });
  }

  focusSelected.addEventListener("change", applyHighlight);
  countryHighlight.addEventListener("change", () => {
    if (countryHighlight.value !== "") clusterHighlight.value = "";
    applyHighlight();
  });
  clusterHighlight.addEventListener("change", () => {
    if (clusterHighlight.value !== "") countryHighlight.value = "";
    applyHighlight();
  });
  showAllClusters.addEventListener("change", () => {
    const prev = clusterHighlight.value;
    buildClusterHighlightDropdown();
    // Try to keep the previous selection if still present.
    if ([...clusterHighlight.options].some((o) => o.value === prev)) {
      clusterHighlight.value = prev;
    } else {
      clusterHighlight.value = "";
    }
    applyHighlight();
  });

  $("pinPositions").addEventListener("click", () => {
    if (!cy || !savedPositionsKey) return;
    const positions = {};
    cy.nodes().forEach((n) => (positions[n.id()] = { ...n.position() }));
    localStorage.setItem(savedPositionsKey, JSON.stringify(positions));
    $("info").textContent = `Saved ${Object.keys(positions).length} node positions.`;
  });

  $("clearPositions").addEventListener("click", () => {
    if (!savedPositionsKey) return;
    localStorage.removeItem(savedPositionsKey);
    $("info").textContent = "Saved positions cleared.";
  });

  loadDataset(DATASETS[0].id).catch((e) => {
    $("info").textContent = `Error loading dataset: ${e.message}`;
  });
}

init();
