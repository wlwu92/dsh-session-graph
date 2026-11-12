#!/usr/bin/env node
/**
 * Render README's knowledge-graph preview from `screenshots/demo.json`.
 *
 * This reuses the real bundle: `lib/client.js` is evaluated with a tiny React
 * stub, then `buildKnowledgeGraph`, `seedGraphPosition` and `tickGraph` from
 * `__test` lay out the demo data. The markup uses the panel's real CSS, so the
 * screenshot stays close to what the plugin renders. It reads no real session
 * data.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { capture, findChrome } from "./capture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const target = join(root, "preview-graph.png");
const WIDTH = 1440;
const HEIGHT = 740;
const GRAPH_WIDTH = 1360;
const GRAPH_HEIGHT = 440;

const esc = (value) => String(value ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

function loadClient() {
  let entry;
  globalThis.window = { __ModuleLoader__: { load(value) { entry = value; } } };
  const source = readFileSync(join(root, "lib/client.js"), "utf8");
  vm.runInThisContext(source, { filename: "dsh-session-graph/lib/client.js" });
  const React = { createElement() {} };
  return entry.factory((name) => {
    if (name === "react") return React;
    throw new Error(`unexpected require: ${name}`);
  });
}

function panelCss() {
  const bundle = readFileSync(join(root, "lib/client.js"), "utf8");
  const match = bundle.match(/const CSS = `([\s\S]*?)`;/);
  if (match === null) throw new Error("lib/client.js: cannot find `const CSS = `");
  return match[1];
}

function buildDemoGraph(client, data) {
  const dimensions = data.facets.items.map((item) => ({
    id: item.id,
    name: item.name,
    tags: []
  }));
  const byName = new Map(dimensions.map((dimension) => [dimension.name, dimension]));
  const tagId = (name) => "tag-" + Buffer.from(name).toString("hex").slice(0, 12);
  const tasks = data.cards.map((card) => {
    const assigned = {};
    for (const dim of card.dims) {
      const dimension = byName.get(dim.name);
      if (dimension === undefined) continue;
      const tags = dim.tags.map((name) => {
        const id = tagId(name);
        if (!dimension.tags.some((tag) => tag.id === id)) dimension.tags.push({ id, name });
        return id;
      });
      assigned[dimension.id] = tags;
    }
    const prefix = card.prs.length === 0 ? "" : `[#${card.prs[0].number}] `;
    return {
      session: card.id,
      title: card.title,
      displayTitle: prefix + card.title,
      summary: card.summary,
      status: card.status === "running" ? "running" : "active",
      dependsOn: card.dependsOn || [],
      dimensions: assigned,
      pullRequests: card.prs.map((pr) => pr.number)
    };
  });
  const prByNumber = new Map();
  for (const card of data.cards) {
    for (const pr of card.prs) {
      prByNumber.set(pr.number, {
        number: pr.number,
        title: pr.title || "",
        state: String(pr.state || "UNKNOWN").toUpperCase(),
        url: `https://github.com/demo/demo-app/pull/${pr.number}`
      });
    }
  }
  const archived = new Set(data.cards.filter((card) => card.status === "archived").map((card) => card.id));
  return client.__test.buildKnowledgeGraph(tasks, { dimensions }, prByNumber, {
    repo: "demo/demo-app",
    archived,
    showTags: true,
    showPrs: true
  });
}

function layout(client, model) {
  const cache = new Map();
  for (const node of [...model.nodes].reverse()) {
    if (cache.has(node.id)) continue;
    const position = client.__test.seedGraphPosition(node, model, GRAPH_WIDTH, GRAPH_HEIGHT, cache);
    cache.set(node.id, { x: position.x, y: position.y });
  }
  const nodes = model.nodes.map((node, index) => {
    const position = cache.get(node.id);
    const value = { ...node, x: position.x, y: position.y, vx: 0, vy: 0, fixed: false, index };
    cache.set(node.id, value);
    return value;
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const links = model.links.map((link, index) => ({
    ...link,
    index,
    source: byId.get(link.source),
    target: byId.get(link.target)
  }));
  const sim = { nodes, links };
  const iterations = 360;
  for (let index = 0; index < iterations; index++) {
    client.__test.tickGraph(sim, GRAPH_WIDTH, GRAPH_HEIGHT, 0.35 + 0.65 * (1 - index / iterations));
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.x - node.r);
    minY = Math.min(minY, node.y - node.r);
    maxX = Math.max(maxX, node.x + node.r);
    maxY = Math.max(maxY, node.y + node.r);
  }
  const padding = 55;
  const k = Math.min(
    (GRAPH_WIDTH - padding * 2) / Math.max(1, maxX - minX),
    (GRAPH_HEIGHT - padding * 2) / Math.max(1, maxY - minY),
    1.5
  );
  return {
    nodes,
    links,
    transform: {
      x: GRAPH_WIDTH / 2 - (minX + maxX) / 2 * k,
      y: GRAPH_HEIGHT / 2 - (minY + maxY) / 2 * k,
      k
    }
  };
}

function renderGraph(layoutResult, model, data, client) {
  const tr = (key, params) => {
    const template = client.__test.zh[key] ?? key;
    return String(template).replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? ""));
  };
  const lines = layoutResult.links.map((link) => {
    const marker = link.kind === "dependency" ? ' marker-end="url(#dsm-graph-arrow)"' : "";
    return `<line class="dsm-graph-link ${esc(link.kind)}" x1="${link.source.x.toFixed(2)}" y1="${link.source.y.toFixed(2)}" x2="${link.target.x.toFixed(2)}" y2="${link.target.y.toFixed(2)}"${marker}></line>`;
  }).join("");
  const nodes = layoutResult.nodes.map((node) => {
    const classes = ["dsm-graph-node", "kind-" + node.kind];
    if (node.archived) classes.push("is-archived");
    if (node.kind === "session" && node.session === "s-8f2a1c") classes.push("is-current");
    if (node.kind === "session" && node.degree >= 4) classes.push("is-hub");
    const label = node.label.length > 22 ? node.label.slice(0, 21) + "…" : node.label;
    const labelY = node.kind === "session" && layoutResult.nodes.indexOf(node) % 2 === 1 ? -node.r - 6 : node.r + 11;
    const rings = [
      node.kind === "session" && node.session === "s-8f2a1c"
        ? `<circle class="dsm-graph-ring" r="${(node.r + 4).toFixed(2)}"></circle>`
        : "",
      node.kind === "session" && node.status === "running"
        ? `<circle class="dsm-graph-run" r="${(node.r + 3).toFixed(2)}"></circle>`
        : ""
    ].join("");
    return `<g class="${classes.join(" ")}" transform="translate(${node.x.toFixed(2)},${node.y.toFixed(2)})">
      <title>${esc(node.tooltip || node.label)}</title>
      ${rings}
      <circle class="dsm-graph-dot" r="${node.r.toFixed(2)}" fill="${esc(node.color)}"></circle>
      <text class="dsm-graph-label" y="${labelY.toFixed(2)}" text-anchor="middle">${esc(label)}</text>
    </g>`;
  }).join("");
  const dimensions = data.facets.items;
  const legend = [
    `<span><i style="background:#c7d2fe"></i>${esc(tr("page.graphSessions"))}</span>`,
    `<span><i class="tag" style="background:#5c7cfa"></i>${esc(tr("page.graphTags"))}</span>`,
    `<span><i class="pr" style="background:#8b7bd8"></i>${esc(tr("page.graphPrs"))}</span>`,
    ...dimensions.map((dimension) => `<span><i style="background:${esc(dimension.color)}"></i>${esc(dimension.name)}</span>`)
  ].join("");
  const views = data.views.map((label, index) => `<button class="${index === 1 ? "on" : ""}" type="button">${esc(label)}</button>`).join("");
  const statusLegend = data.legend.map(([status, label]) => `<span><i class="${esc(status)}"></i>${esc(label)}</span>`).join("");
  const toolbarButtons = [
    `<button type="button">${esc(tr("page.graphFocus"))}</button>`,
    `<span class="dsm-graph-sep"></span>`,
    `<button class="on" type="button">${esc(tr("page.graphTags"))}</button>`,
    `<button class="on" type="button">${esc(tr("page.graphPrs"))}</button>`,
    `<button type="button">${esc(tr("page.graphArrows"))}</button>`,
    `<span class="dsm-graph-sep"></span>`,
    `<button type="button">−</button>`,
    `<button type="button">+</button>`,
    `<button type="button">${esc(tr("page.graphFit"))}</button>`,
    `<button type="button">${esc(tr("page.graphRelayout"))}</button>`
  ].join("");

  return `<div class="dsm-root">
  <header class="dsm-head">
    <div>
      <h1 class="dsm-title">${esc(data.title)}</h1>
      <p class="dsm-sub">${esc(data.sub)}</p>
    </div>
    <span class="dsm-source" title="${esc(data.source)}">${esc(data.source)}</span>
  </header>
  <div class="dsm-toolbar">
    <select class="dsm-project-select"><option>${esc(data.project)}</option></select>
    <button class="dsm-btn" type="button">${esc(data.buttons.refresh)}</button>
    <button class="dsm-btn primary" type="button">${esc(data.buttons.summaries)}</button>
    <button class="dsm-btn" type="button">${esc(data.buttons.prs)}</button>
    <span class="dsm-spacer"></span>
    <input class="dsm-search" type="search" placeholder="${esc(data.search)}">
    <div class="dsm-seg">${views}</div>
    <label class="dsm-toggle"><input type="checkbox">${esc(data.showArchived)}</label>
    <div class="dsm-legend">${statusLegend}</div>
  </div>
  <div class="dsm-graph" data-zoom="${layoutResult.transform.k < 0.55 ? "far" : layoutResult.transform.k < 1.35 ? "mid" : "near"}">
    <svg viewBox="0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(tr("page.graph"))}">
      <defs>
        <marker id="dsm-graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#8c96a8"></path>
        </marker>
      </defs>
      <g transform="translate(${layoutResult.transform.x.toFixed(2)},${layoutResult.transform.y.toFixed(2)}) scale(${layoutResult.transform.k.toFixed(3)})">
        <g>${lines}</g>
        <g>${nodes}</g>
      </g>
    </svg>
    <div class="dsm-graph-toolbar">${toolbarButtons}</div>
    <div class="dsm-graph-legend">${legend}</div>
  </div>
  <p class="dsm-note">${esc(tr("page.graphNote"))}</p>
</div>`;
}

const chrome = findChrome();
if (chrome === undefined) {
  console.error("找不到 Chrome/Chromium/Edge；装一个或用 CHROME=/path/to/chrome 指定");
  process.exit(1);
}

const client = loadClient();
const data = JSON.parse(readFileSync(join(here, "demo.json"), "utf8"));
const model = buildDemoGraph(client, data);
const layoutResult = layout(client, model);
const outDir = join(here, "out");
mkdirSync(outDir, { recursive: true });
const htmlPath = join(outDir, "graph.html");
writeFileSync(htmlPath, `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>dsh-session-graph graph preview</title>
<style>
html, body { height: 100%; margin: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif; }
.dsm-root { padding-bottom: 30px; }
</style>
<style>${panelCss()}</style>
</head>
<body>${renderGraph(layoutResult, model, data, client)}</body>
</html>`);

const browser = process.env.CHROME || chrome;
await capture(browser, htmlPath, target, WIDTH, HEIGHT);

console.log(`ok: wrote ${target} (${model.stats.sessions} sessions, ${model.stats.tags} tags, ${model.stats.prs} PRs, ${model.stats.links} links)`);
