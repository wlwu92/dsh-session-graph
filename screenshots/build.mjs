#!/usr/bin/env node
/**
 * 从插件项目里生成 README 用的截图。
 *
 * 做法：从 `lib/client.js` 取出面板真实的 CSS，用 `screenshots/demo.json` 的假数据拼一份
 * 静态 HTML，再用无头 Chrome 截成 `preview.png`。全程不读取任何真实会话数据，所以截图
 * 可以安全公开。改样式后重跑 `npm run screenshots` 即可让预览跟上。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { capture, findChrome } from "./capture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const target = join(root, "preview.png");
const WIDTH = 1440;
const HEIGHT = 640;

const STATUS_LABELS = { running: "运行中", active: "活跃", archived: "已归档" };

const esc = (value) => String(value ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

function panelCss() {
  const bundle = readFileSync(join(root, "lib/client.js"), "utf8");
  const match = bundle.match(/const CSS = `([\s\S]*?)`;/);
  if (match === null) throw new Error("lib/client.js: cannot find `const CSS = `");
  return match[1];
}

function renderCard(item) {
  const displayTitle = item.prs.length === 0
    ? item.title
    : `[#${item.prs[0].number}] ${item.title}`;
  const dims = item.dims.length === 0
    ? `<div class="dsm-card-dims is-empty">未分类</div>`
    : `<div class="dsm-card-dims">${item.dims.map((dim) => `
        <div class="dsm-card-dim">
          <span class="dsm-card-dim-dot" style="background:${esc(dim.color)}"></span>
          <span class="dsm-card-dim-name">${esc(dim.name)}</span>
          ${dim.tags.map((tag) => `<span class="dsm-chip">${esc(tag)}</span>`).join("")}
        </div>`).join("")}</div>`;
  const prs = item.prs.length === 0
    ? ""
    : `<div class="dsm-card-prs">${item.prs.map((pr) =>
        `<a class="dsm-pr-chip ${esc(pr.state)}" href="#">#${pr.number}</a>`).join("")}</div>`;
  return `<article class="dsm-card${item.current ? " is-current" : ""}${item.status === "archived" ? " is-archived" : ""}" style="--dsm-accent:#4c6ef5;--dsm-bg:#fafbff">
    <div class="dsm-card-head">
      <span class="dsm-dot ${item.status}"></span>
      <h3 class="dsm-card-title">${esc(displayTitle)}</h3>
      ${item.current ? `<span class="dsm-card-badge">当前</span>` : ""}
      <button class="dsm-card-menu" type="button" aria-label="更多">⋯</button>
    </div>
    <p class="dsm-card-summary">${esc(item.summary)}</p>
    ${dims}
    ${prs}
    <div class="dsm-card-foot">
      <span>${esc(item.id)}</span>
      <span>${esc(STATUS_LABELS[item.status] ?? item.status)}</span>
      <span class="dsm-card-time">${esc(item.time)}</span>
    </div>
  </article>`;
}

function renderFacets(facets) {
  const items = facets.items
    .map((item, index) => `<button class="dsm-facet${index === 0 ? " is-active" : ""}" type="button">
      <span class="dsm-facet-dot" style="background:${esc(item.color)}"></span>
      <span class="dsm-facet-name">${esc(item.name)}</span>
      <span class="dsm-facet-count">${item.count}</span>
    </button>`)
    .join("");
  const tags = facets.tags
    .map((tag) => `<button class="dsm-tag" type="button">${esc(tag.name)} ${tag.count}</button>`)
    .join("");
  return `<aside class="dsm-facets">
    <div class="dsm-facets-scroll">
      <div class="dsm-facets-title">${esc(facets.title)}</div>
      <button class="dsm-facet" type="button">
        <span class="dsm-facet-dot" style="background:#6b8afd"></span>
        <span class="dsm-facet-name">${esc(facets.all.name)}</span>
        <span class="dsm-facet-count">${facets.all.count}</span>
      </button>
      ${items}
      <div class="dsm-tag-filter">
        <div class="dsm-tag-title">${esc(facets.tagsTitle)}</div>
        <button class="dsm-tag is-active" type="button">${esc(facets.allTags)}</button>
        ${tags}
      </div>
    </div>
    <div class="dsm-facets-foot">
      <button class="dsm-facet-action" type="button">${esc(facets.generate)}</button>
    </div>
  </aside>`;
}

function render(data) {
  const cards = data.cards.map(renderCard).join("");
  const legend = data.legend
    .map(([status, label]) => `<span><i class="${esc(status)}"></i>${esc(label)}</span>`)
    .join("");
  const views = data.views
    .map((label, index) => `<button class="${index === 0 ? "on" : ""}" type="button">${esc(label)}</button>`)
    .join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>dsh-session-graph preview</title>
<style>
html, body { margin: 0; padding: 0; background: #fff; }
body { font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif; }
</style>
<style>${panelCss()}</style>
</head>
<body>
<div class="dsm-root">
  <header class="dsm-head">
    <div>
      <h1 class="dsm-title">${esc(data.title)}</h1>
      <p class="dsm-sub">${esc(data.sub)}</p>
    </div>
    <span class="dsm-source" title="${esc(data.source)}">${esc(data.source)}</span>
  </header>
  <div class="dsm-toolbar">
    <select class="dsm-project-select"><option>${esc(data.project)}</option></select>
    <button class="dsm-btn primary" type="button">${esc(data.buttons.summaries)}</button>
    <span class="dsm-spacer"></span>
    <input class="dsm-search" type="search" placeholder="${esc(data.search)}">
    <div class="dsm-seg">${views}</div>
    <label class="dsm-toggle"><input type="checkbox">${esc(data.showArchived)}</label>
    <div class="dsm-legend">${legend}</div>
  </div>
  <div class="dsm-summary-status is-empty"></div>
  <div class="dsm-body">
    ${renderFacets(data.facets)}
    <section class="dsm-cards">
      <div class="dsm-card-grid">${cards}</div>
    </section>
  </div>
  <p class="dsm-note">${esc(data.note)}</p>
</div>
</body>
</html>`;
}

const chrome = findChrome();
if (chrome === undefined) {
  console.error("找不到 Chrome/Chromium/Edge；装一个或用 CHROME=/path/to/chrome 指定");
  process.exit(1);
}
const browser = process.env.CHROME || chrome;

const data = JSON.parse(readFileSync(join(here, "demo.json"), "utf8"));
const outDir = join(here, "out");
mkdirSync(outDir, { recursive: true });
const htmlPath = join(outDir, "preview.html");
writeFileSync(htmlPath, render(data));

await capture(browser, htmlPath, target, WIDTH, HEIGHT);

console.log(`wrote ${target} (${WIDTH}x${HEIGHT})`);
