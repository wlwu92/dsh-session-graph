/**
 * Load the built client bundle in Node with a fake module loader and a fake
 * Cordis context. This does not render React; it verifies:
 *   - the `window.__ModuleLoader__` registration shape,
 *   - the `main` / `sidebar.panellist` registrations,
 *   - that the card view renders and clicking a card calls `uiWorkspace.openSession`,
 *   - that taxonomy, tags and PR numbers parse and render.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

let entry;
globalThis.window = {
  __ModuleLoader__: {
    load(value) {
      entry = value;
    }
  },
  localStorage: {
    getItem(key) {
      return key === "dsh-session-graph.project.v1" ? "workspace-1" : null;
    },
    setItem() {},
    removeItem() {}
  }
};

const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
assert.equal(manifest.dsh?.client?.platform, "web");
assert.equal(manifest.exports?.["./client"], "./lib/client.js");
assert.equal(manifest.dsh?.bundle?.patch, "./cordis.patch.yml");
assert.ok(fs.existsSync(new URL("../cordis.patch.yml", import.meta.url)), "bundle patch is missing");

const source = fs.readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
vm.runInThisContext(source, { filename: "dsh-session-graph/lib/client.js" });

assert.equal(entry.id, "dsh-session-graph");

const React = {
  Component: class Component {
    constructor(props) {
      this.props = props;
    }
  },
  createElement(type, props, ...children) {
    return { type, props: props || {}, children };
  },
  useState(initial) {
    return [typeof initial === "function" ? initial() : initial, () => {}];
  },
  useEffect(run) {
    run();
  }
};

const client = entry.factory((name) => {
  if (name === "react") return React;
  throw new Error(`unexpected require: ${name}`);
});

const opened = [];
const registrations = [];
const dictionaries = {};
const translate = (key, params) => {
  const template = dictionaries[key] ?? key;
  return String(template).replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? ""));
};
const fakeFiles = {
  async read() {
    return { ok: false, error: { code: "workspace-file/not-found", message: "missing" } };
  }
};
const ctx = {
  remote: { workspaceFiles: fakeFiles },
  effect(run) {
    run();
  },
  locale: {
    register(namespace, dicts) {
      assert.equal(namespace, "session-graph");
      Object.assign(dictionaries, dicts.zh ?? dicts.en);
    },
    bind(namespace) {
      assert.equal(namespace, "session-graph");
      return translate;
    }
  },
  get(name) {
    assert.equal(name, "uiWorkspace");
    return {
      openSession(sessionId) {
        opened.push(sessionId);
      }
    };
  },
  slots: {
    inject(name, register) {
      registrations.push({ name, registration: register() });
    },
    register(options, Component) {
      return { options, Component };
    }
  }
};

client.apply(ctx);

const main = registrations.find((item) => item.name === "main");
const sidebar = registrations.find((item) => item.name === "sidebar.panellist");
assert.ok(main, "main slot was not registered");
assert.ok(sidebar, "sidebar.panellist slot was not registered");
assert.equal(main.registration.options.key, "session-graph");
assert.equal(sidebar.registration.options.id, "session-graph");
assert.equal(sidebar.registration.options.label(), "会话地图");
assert.equal(sidebar.registration.Component({ size: 16 }).type, "svg");

main.registration.options.inject().openSession("session-probe");
assert.deepEqual(opened, ["session-probe"]);

const now = Date.now();
const list = {
  ids: ["session-a", "session-b", "session-c", "session-d", "session-e"],
  byId: {
    "session-a": {
      id: "session-a",
      displayTitle: "Alpha",
      cwd: "/repo",
      running: true,
      updatedAt: now - 60_000,
      blank: false
    },
    "session-b": {
      id: "session-b",
      displayTitle: "Beta",
      cwd: "/repo",
      running: false,
      updatedAt: now - 3_600_000,
      blank: false
    },
    "session-c": {
      id: "session-c",
      displayTitle: "Archived",
      cwd: "/repo",
      running: false,
      updatedAt: now - 7_200_000,
      blank: false
    },
    "session-d": {
      id: "session-d",
      displayTitle: "Subagent",
      cwd: "/repo",
      running: false,
      updatedAt: now,
      blank: false,
      origin: "subagent"
    },
    "session-e": {
      id: "session-e",
      displayTitle: "Fork",
      cwd: "/repo",
      running: false,
      updatedAt: now - 30_000,
      blank: false,
      origin: "fork",
      parentId: "session-a"
    }
  }
};
const workspaces = {
  items: [{ workspaceId: "workspace-1", path: "/repo", title: "repo", sessionIds: ["session-a", "session-b", "session-c", "session-e"] }],
  archivedSessionIds: ["session-c"]
};

const page = main.registration.Component({
  useSessions: (selector) => selector(list),
  useWorkspaces: (selector) => selector(workspaces),
  openSession: (sessionId) => opened.push(sessionId),
  workspaceFiles: {
    async read() {
      return { ok: false, error: { code: "workspace-file/not-found", message: "missing" } };
    }
  },
  t: translate
});

const walk = (node, visit) => {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node !== "object") return;
  if (typeof node.type === "function") {
    const source = Function.prototype.toString.call(node.type);
    if (source.startsWith("class")) {
      const instance = new node.type({ ...node.props, children: node.children });
      walk(instance.render(), visit);
      return;
    }
    walk(node.type(node.props), visit);
    return;
  }
  visit(node);
  if (Array.isArray(node.children)) {
    for (const child of node.children) walk(child, visit);
  }
};

const findAll = (node, predicate) => {
  const found = [];
  walk(node, (child) => {
    if (predicate(child)) found.push(child);
  });
  return found;
};

const findOne = (node, predicate) => findAll(node, predicate)[0];

const generateAction = findOne(page, (node) => node.props?.className === "dsm-facet-action");
assert.ok(generateAction, "generate dimensions action must live in the facet rail");
assert.equal(generateAction.children[0], "生成维度");
const facetFoot = findOne(page, (node) => node.props?.className === "dsm-facets-foot");
assert.ok(facetFoot, "generate dimensions action must sit in the facet footer");
assert.ok(findOne(facetFoot, (node) => node.props?.className === "dsm-facet-action"));

const cards = findAll(page, (node) => typeof node.props?.className === "string" &&
  node.props.className.split(" ").includes("dsm-card"));
assert.equal(cards.length, 3, "archived and subagent rows must be filtered out, but forks stay");

const cardTitle = (card) => findOne(card, (node) => node.props?.className === "dsm-card-title")?.children?.[0];
const names = cards.map(cardTitle).sort();
assert.deepEqual(names, ["Alpha", "Beta", "Fork"]);

const alpha = cards.find((card) => cardTitle(card) === "Alpha");
alpha.props.onClick();
assert.equal(opened.at(-1), "session-a");

const v3 = client.__test.parseSessionGraph(
  "```json\n" +
  JSON.stringify({
    version: 3,
    repo: "example/repo",
    taxonomy: {
      dimensions: [
        {
          id: "labeling",
          name: "视频打标",
          tags: [
            { id: "prompt", name: "提示词" },
            { id: "worker", name: "Worker" }
          ]
        }
      ]
    },
    pullRequests: [
      {
        number: 606,
        title: "test(general-video-label): 添加回归评测集",
        url: "https://github.com/example/repo/pull/606",
        state: "OPEN"
      }
    ],
    sessions: [
      {
        session: "session-a",
        title: "General 打标提示词",
        summary: "收紧 General 打标口径。",
        dimensions: { labeling: ["prompt"] },
        pullRequests: [606],
        dependsOn: []
      }
    ]
  }) +
  "\n```"
);
assert.equal(v3.entries.length, 1);
assert.deepEqual(v3.entries[0].dimensions, { labeling: ["prompt"] });
assert.deepEqual(v3.entries[0].pullRequests, [606]);
assert.equal(v3.taxonomy.dimensions.length, 1);
assert.equal(v3.pullRequests[0].state, "OPEN");
assert.equal(v3.repo, "example/repo");

const card = client.__test.SessionCard({
  task: {
    session: "session-a",
    title: "General 打标提示词",
    displayTitle: "[#606] General 打标提示词",
    summary: "收紧 General 打标口径。",
    dependsOn: [],
    dimensions: { labeling: ["prompt"] },
    pullRequests: [606]
  },
  row: list.byId["session-a"],
  archived: new Set(),
  isCurrent: false,
  taxonomy: v3.taxonomy,
  prByNumber: new Map([[606, v3.pullRequests[0]]]),
  repo: v3.repo,
  tr: translate,
  onOpen() {},
  onMenu() {}
});
assert.equal(findOne(card, (node) => node.props?.className === "dsm-card-title").children[0], "[#606] General 打标提示词");
assert.equal(findOne(card, (node) => node.props?.className === "dsm-chip").children[0], "提示词");
const prChip = findOne(card, (node) => typeof node.props?.className === "string" &&
  node.props.className.includes("dsm-pr-chip"));
assert.equal(prChip.props.href, "https://github.com/example/repo/pull/606");

const prPanel = client.__test.PrPanel({
  pullRequests: [
    ...v3.pullRequests,
    {
      number: 607,
      title: "unlinked PR",
      url: "https://github.com/example/repo/pull/607",
      state: "OPEN",
      author: "someone",
      updatedAt: ""
    }
  ],
  tasks: [{
    session: "session-a",
    title: "General 打标提示词",
    displayTitle: "[#606] General 打标提示词",
    summary: "",
    pullRequests: [606]
  }],
  repo: v3.repo,
  tr: translate,
  onOpenSession: (sessionId) => opened.push(sessionId),
  onRefresh() {},
  busy: false
});
const prRows = findAll(prPanel, (node) => typeof node.props?.className === "string" &&
  node.props.className.split(" ").includes("dsm-pr-row"));
assert.equal(prRows.length, 1, "default PR scope must only show PRs linked to a session");
const prTitle = findOne(prPanel, (node) => node.props?.className === "dsm-pr-title");
assert.equal(prTitle.props.href, "https://github.com/example/repo/pull/606");
const sessionChip = findOne(prPanel, (node) => node.props?.className === "dsm-session-chip");
sessionChip.props.onClick();
assert.equal(opened.at(-1), "session-a");

const legacy = client.__test.parseSessionGraph(
  "```json\n" +
  JSON.stringify({
    tasks: [
      { id: "a", title: "Task A", session: "session-a", status: "done", dependsOn: [] },
      { id: "b", title: "Task B", session: "session-b", status: "running", dependsOn: ["a"] }
    ]
  }) +
  "\n```"
);
assert.equal(legacy.entries.length, 2);
const taskLayout = client.__test.layoutTasks([
  { id: "a", title: "Task A", session: "session-a", status: "done", dependsOn: [] },
  { id: "b", title: "Task B", session: "session-b", status: "running", dependsOn: ["a"] }
]);
assert.equal(taskLayout.nodes.length, 2);
assert.equal(taskLayout.edges.length, 1);
assert.ok(taskLayout.nodes[0].x < taskLayout.nodes[1].x, "dependency target must be to the right");

console.log("ok: bundle loads, cards render, taxonomy/PR data parse, click opens sessions");
