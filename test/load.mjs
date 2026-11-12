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
  useRef(initial) {
    return { current: initial };
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
  remote: {
    workspaceFiles: fakeFiles,
    session: {
      async rename() {
        return { ok: true, value: { title: "synced", seq: 1 } };
      }
    }
  },
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
    if (name === "sessions") {
      return {
        async refresh() {}
      };
    }
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

const mainProps = main.registration.options.inject();
mainProps.openSession("session-probe");
assert.deepEqual(opened, ["session-probe"]);
assert.equal(typeof mainProps.renameSession, "function", "the panel must receive the session rename hop");
assert.deepEqual(
  await mainProps.renameSession("session-a", "synced"),
  { title: "synced", seq: 1 },
  "the rename hop must return the host result"
);
assert.equal(typeof mainProps.refreshSessions, "function", "the panel must receive the session-list refresh");
await mainProps.refreshSessions();

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

const titleChanges = client.__test.changedSessionTitles(
  [
    { session: "session-a", title: "Old A" },
    { session: "session-b", title: "Same B" },
    { session: "session-c", title: "Old C" }
  ],
  [
    { session: "session-a", title: "New A" },
    { session: "session-b", title: "Same B" },
    { session: "session-c", title: "New C" },
    { session: "session-d", title: "Brand new" }
  ],
  {
    "session-a": { displayTitle: "Old A" },
    "session-b": { displayTitle: "Same B" },
    "session-c": { displayTitle: "Old C" },
    "session-d": { displayTitle: "Old D" }
  }
);
assert.deepEqual(titleChanges, [
  { session: "session-a", title: "New A" },
  { session: "session-c", title: "New C" }
], "only known sessions whose title changed should be synced");

assert.deepEqual(
  client.__test.changedSessionTitles(
    [{ session: "session-a", title: "Old A" }],
    [{ session: "session-a", title: "New A" }],
    { "session-a": { displayTitle: "New A" } }
  ),
  [],
  "a session already carrying the new title must not be renamed again"
);

assert.deepEqual(
  client.__test.changedSessionTitles([], [{ session: "session-a", title: "New A" }], {}),
  [],
  "an unloaded graph baseline must not rename every session"
);

assert.deepEqual(
  client.__test.changedSessionTitles(
    [{ session: "session-a", title: "Old A", pullRequests: [613] }],
    [{ session: "session-a", title: "New A", pullRequests: [613] }],
    { "session-a": { displayTitle: "Old A" } }
  ),
  [{ session: "session-a", title: "[#613] New A" }],
  "the renamed session title must carry the same PR prefix as the card"
);

assert.deepEqual(
  client.__test.changedSessionTitles(
    [{ session: "session-a", title: "Same A", pullRequests: [] }],
    [{ session: "session-a", title: "Same A", pullRequests: [613] }],
    { "session-a": { displayTitle: "Same A" } }
  ),
  [{ session: "session-a", title: "[#613] Same A" }],
  "adding a PR association must also refresh the session title prefix"
);

const syncGraphText = "```json\n" +
  JSON.stringify({
    version: 3,
    sessions: [
      { session: "session-a", title: "New A", pullRequests: [613] },
      { session: "session-b", title: "New B" },
      { session: "session-c", title: "Same C" }
    ]
  }) +
  "\n```";
const renames = [];
let sessionRefreshes = 0;
const syncResult = await client.__test.syncSessionTitles({
  beforeEntries: [
    { session: "session-a", title: "Old A", pullRequests: [613] },
    { session: "session-b", title: "New B" },
    { session: "session-c", title: "Same C" }
  ],
  workspaceFiles: {
    async read() {
      return { ok: true, value: { text: syncGraphText } };
    }
  },
  readSessionId: "session-a",
  filePath: "/repo/DSH_SESSION_GRAPH.md",
  byId: {
    "session-a": { displayTitle: "Old A" },
    "session-b": { displayTitle: "New B" },
    "session-c": { displayTitle: "Same C" }
  },
  renameSession: async (sessionId, title) => {
    renames.push([sessionId, title]);
  },
  refreshSessions: async () => {
    sessionRefreshes += 1;
  }
});
assert.deepEqual(renames, [["session-a", "[#613] New A"]], "only the changed title is written back, with its PR prefix");
assert.deepEqual(syncResult, { synced: 1, failed: 0 });
assert.equal(sessionRefreshes, 1, "the session list is refreshed after a sync");

const reconcileRenames = [];
const reconcileResult = await client.__test.syncSessionTitles({
  beforeEntries: [{ session: "session-a", title: "Same A", pullRequests: [613] }],
  workspaceFiles: {
    async read() {
      return {
        ok: true,
        value: {
          text: "```json\n" + JSON.stringify({
            version: 3,
            sessions: [{ session: "session-a", title: "Same A", pullRequests: [613] }]
          }) + "\n```"
        }
      };
    }
  },
  readSessionId: "session-a",
  filePath: "/repo/DSH_SESSION_GRAPH.md",
  byId: { "session-a": { displayTitle: "Old A" } },
  renameSession: async (sessionId, title) => {
    reconcileRenames.push([sessionId, title]);
  },
  refreshSessions: async () => {},
  includeSession: "session-a"
});
assert.deepEqual(reconcileRenames, [["session-a", "[#613] Same A"]], "a targeted summarize reconciles an existing mismatch, with the PR prefix");
assert.deepEqual(reconcileResult, { synced: 1, failed: 0 });

const originalWarn = console.warn;
console.warn = () => {};
const failedRename = await client.__test.syncSessionTitles({
  beforeEntries: [{ session: "session-a", title: "Old A" }],
  workspaceFiles: {
    async read() {
      return { ok: true, value: { text: syncGraphText } };
    }
  },
  readSessionId: "session-a",
  filePath: "/repo/DSH_SESSION_GRAPH.md",
  byId: { "session-a": { displayTitle: "Old A" } },
  renameSession: async () => {
    throw new Error("rename refused");
  },
  refreshSessions: async () => {
    throw new Error("refresh must not run when every rename failed");
  }
});
console.warn = originalWarn;
assert.deepEqual(failedRename, { synced: 0, failed: 1 }, "a rename failure must not fail the summary");

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

const graphTasks = [
  {
    session: "session-a",
    title: "A",
    displayTitle: "A",
    summary: "",
    status: "running",
    dependsOn: [],
    dimensions: { labeling: ["prompt"] },
    pullRequests: [606]
  },
  {
    session: "session-b",
    title: "B",
    displayTitle: "B",
    summary: "",
    status: "active",
    dependsOn: ["session-a"],
    dimensions: { labeling: ["worker"] },
    pullRequests: []
  }
];
const graph = client.__test.buildKnowledgeGraph(graphTasks, v3.taxonomy, new Map([[606, v3.pullRequests[0]]]), {
  repo: v3.repo,
  archived: new Set()
});
assert.equal(graph.nodes.filter((node) => node.kind === "session").length, 2);
assert.equal(graph.nodes.filter((node) => node.kind === "tag").length, 2);
assert.equal(graph.nodes.filter((node) => node.kind === "pr").length, 1);
assert.equal(graph.links.filter((link) => link.kind === "dependency").length, 1);
assert.equal(graph.links.filter((link) => link.kind === "tag").length, 2);
assert.equal(graph.links.filter((link) => link.kind === "pr").length, 1);
assert.equal(graph.stats.sessions, 2);
assert.equal(graph.stats.links, 4);
assert.ok(graph.nodes.every((node) => node.r > 0), "every graph node gets a radius");
assert.equal(graph.byId.get("pr:606").url, "https://github.com/example/repo/pull/606");

const localGraph = client.__test.buildKnowledgeGraph(graphTasks, v3.taxonomy, new Map([[606, v3.pullRequests[0]]]), {
  repo: v3.repo,
  archived: new Set(),
  localDepth: 1,
  focusSession: "session-a"
});
assert.ok(localGraph.byId.has("session:session-b"), "depth 1 keeps the dependent session");
assert.ok(localGraph.byId.has("tag:labeling:prompt"), "depth 1 keeps the focused session tag");
assert.ok(localGraph.byId.has("pr:606"), "depth 1 keeps the focused session PR");
assert.ok(!localGraph.byId.has("tag:labeling:worker"), "depth 1 excludes the neighbour's tag");

const noTags = client.__test.buildKnowledgeGraph(graphTasks, v3.taxonomy, new Map([[606, v3.pullRequests[0]]]), {
  showTags: false,
  showPrs: false
});
assert.equal(noTags.nodes.filter((node) => node.kind === "tag").length, 0);
assert.equal(noTags.nodes.filter((node) => node.kind === "pr").length, 0);

const graphView = client.__test.GraphView({
  tasks: graphTasks,
  taxonomy: v3.taxonomy,
  prByNumber: new Map([[606, v3.pullRequests[0]]]),
  repo: v3.repo,
  archived: new Set(),
  currentSessionId: "session-a",
  tr: translate,
  onOpen: (sessionId) => opened.push(sessionId),
  onMenu() {}
});
const graphNodes = findAll(graphView, (node) => typeof node.props?.className === "string" &&
  node.props.className.split(" ").includes("dsm-graph-node"));
assert.equal(graphNodes.length, graph.nodes.length, "the graph renders a node per model node");
const graphLinks = findAll(graphView, (node) => typeof node.props?.className === "string" &&
  node.props.className.split(" ").includes("dsm-graph-link"));
assert.equal(graphLinks.length, graph.links.length, "the graph renders a line per model link");
const graphToolbar = findOne(graphView, (node) => node.props?.className === "dsm-graph-toolbar");
assert.ok(graphToolbar, "the graph toolbar is rendered");
const graphLegend = findOne(graphView, (node) => node.props?.className === "dsm-graph-legend");
assert.ok(graphLegend, "the graph legend is rendered");
const sessionNode = graphNodes.find((node) => node.props["aria-label"] === "A, 运行中");
assert.ok(sessionNode, "session nodes keep their status label");
sessionNode.props.onClick();
assert.equal(opened.at(-1), "session-a");

console.log("ok: bundle loads, cards render, knowledge graph builds and renders, taxonomy/PR data parse, click opens sessions");
