/**
 * DSH Web client plugin: a session map.
 *
 * Views:
 *   cards - session cards grouped by project dimensions and tags
 *   graph - an Obsidian-style knowledge graph: sessions, tags and PRs are
 *           nodes; dependency, tag and PR relations are links. It uses a
 *           force layout (no trees, no columns) with pan/zoom and a local
 *           graph mode focused on the current session.
 *   prs   - the project pull-request catalog
 *
 * The panel reads the selected project's DSH_SESSION_GRAPH.md through the DSH
 * workspaceFiles Remote. The file is written by the host side's /summarize-*
 * commands; the live session/workspace state supplies status and navigation.
 */
window.__ModuleLoader__.load({
	id: "dsh-session-graph",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;
		const NS = "session-graph";
		const PANEL_ID = "session-graph";
		const EMPTY_LIST = { ids: [], byId: {} };
		const EMPTY_WORKSPACES = { items: [], archivedSessionIds: [] };
		const PROJECT_STORAGE_KEY = "dsh-session-graph.project.v1";
		const DIMENSION_COLORS = ["#5c7cfa", "#0ca678", "#f08c00", "#9c36b5", "#1098ad", "#e64980", "#5f3dc4", "#2b8a3e"];
		const STATUS_COLORS = { running: "#2f9e44", active: "#4c6ef5", archived: "#adb5bd" };
		const GRAPH_NEUTRAL = "#8b95a5";
		const GRAPH_PR_COLORS = { OPEN: "#2f9e44", MERGED: "#8b7bd8", CLOSED: "#e05d5d", UNKNOWN: "#7d8694" };
		const GRAPH_LINK_DISTANCE = { dependency: 118, tag: 72, pr: 66 };
		const GRAPH_LINK_STRENGTH = { dependency: 0.032, tag: 0.055, pr: 0.048 };
		const GRAPH_LOCAL_DEPTH = 2;
		const CARD_TINTS = { running: "#f7fdf9", active: "#fafbff", archived: "#fbfbfc" };
		const EMPTY_GRAPH = {
			phase: "idle",
			entries: [],
			error: "",
			title: "",
			kind: "read",
			taxonomy: { dimensions: [] },
			pullRequests: [],
			repo: ""
		};

		function readStoredProject() {
			try {
				if (typeof window === "undefined" || window.localStorage === undefined) return "";
				return window.localStorage.getItem(PROJECT_STORAGE_KEY) || "";
			} catch {
				return "";
			}
		}

		function storeProject(projectId) {
			try {
				if (typeof window === "undefined" || window.localStorage === undefined) return;
				if (projectId === "") window.localStorage.removeItem(PROJECT_STORAGE_KEY);
				else window.localStorage.setItem(PROJECT_STORAGE_KEY, projectId);
			} catch {
				/* storage unavailable: keep the in-memory selection */
			}
		}

		const zh = {
			"meta.title": "会话地图",
			"meta.description": "按项目主线维度与标签展示会话卡片，并汇总项目 PR 信息。",
			"panel.label": "会话地图",
			"page.title": "会话地图",
			"page.sub": "{count} 个会话 · {dimensions} 条主线 · {prs} 个关联 PR",
			"page.countSessionsOne": "{count} 个会话",
			"page.countSessionsMany": "{count} 个会话",
			"page.countMainlinesOne": "{count} 条主线",
			"page.countMainlinesMany": "{count} 条主线",
			"page.countLinkedPrsOne": "{count} 个关联 PR",
			"page.countLinkedPrsMany": "{count} 个关联 PR",
			"page.countArchivedOne": "另有 {count} 个已归档",
			"page.countArchivedMany": "另有 {count} 个已归档",
			"page.countCardsOne": "{count} 个会话",
			"page.countCardsMany": "{count} 个会话",
			"page.countDependenciesOne": "{count} 条依赖",
			"page.countDependenciesMany": "{count} 条依赖",
			"page.countPrSessionsOne": "{count} 个相关会话",
			"page.countPrSessionsMany": "{count} 个相关会话",
			"page.countPrsOne": "{count} 个 PR",
			"page.countPrsMany": "{count} 个 PR",
			"page.countOpenOne": "{count} 个打开",
			"page.countOpenMany": "{count} 个打开",
			"page.countMergedOne": "{count} 个已合并",
			"page.countMergedMany": "{count} 个已合并",
			"page.justNow": "刚刚",
			"page.minutesAgo": "{count} 分钟前",
			"page.hoursAgo": "{count} 小时前",
			"page.daysAgo": "{count} 天前",
			"page.graphReadyPrefix": "DSH_SESSION_GRAPH.md",
			"page.archivedCount": "另有 {count} 个已归档",
			"page.showArchived": "显示已归档",
			"page.running": "运行中",
			"page.active": "活跃",
			"page.archived": "已归档",
			"page.fork": "Fork",
			"page.current": "当前",
			"page.empty": "没有可显示的会话。",
			"page.noMatches": "没有匹配的会话。",
			"page.cards": "卡片",
			"page.graph": "知识图谱",
			"page.graphNote": "知识图谱把会话、标签和 PR 连成一张网：悬停高亮邻居，滚轮缩放，拖背景平移，拖节点固定，点击会话切换；编辑 DSH_SESSION_GRAPH.md 后点「刷新」。",
			"page.graphSessions": "会话",
			"page.graphTags": "标签",
			"page.graphPrs": "PR",
			"page.graphArrows": "箭头",
			"page.graphFocus": "聚焦当前",
			"page.graphFocusOn": "已聚焦",
			"page.graphFocusHint": "只显示当前会话 {depth} 跳以内的节点和连线",
			"page.graphFit": "适应",
			"page.graphRelayout": "重排",
			"page.graphZoomIn": "放大",
			"page.graphZoomOut": "缩小",
			"page.graphEmpty": "没有可显示的节点。",
			"page.prs": "PR",
			"page.searchPlaceholder": "搜索标题、摘要、标签或 PR",
			"page.dimensions": "主线维度",
			"page.allSessions": "全部会话",
			"page.uncategorized": "未分类",
			"page.tags": "标签",
			"page.allTags": "全部标签",
			"page.taxonomyMissing": "还没有项目维度。点「主线维度」面板底部的「生成维度」建立主线与标签。",
			"page.cardsCount": "{count} 个会话",
			"page.noSummary": "暂无摘要，「生成摘要」后可按功能分类。",
			"page.generateTaxonomy": "生成维度",
			"page.generateSummaries": "生成摘要",
			"page.refresh": "刷新",
			"page.refreshPrs": "刷新 PR",
			"page.generating": "生成中…",
			"page.taxonomyRunning": "正在生成项目维度、标签与 PR…",
			"page.summaryRunning": "正在生成会话摘要与标签…",
			"page.prRunning": "正在刷新 PR 信息…",
			"page.summaryDone": "已更新，正在刷新面板…",
			"page.summaryUnavailable": "摘要命令未安装；更新插件后重启 DSH 再试。",
			"page.summaryNoSession": "没有可用于执行命令的 session。",
			"page.summaryFailed": "执行失败：{message}",
			"page.summarySynced": "已同步 {count} 个 session 标题",
			"page.summarySyncFailed": "{count} 个标题同步失败",
			"page.taxonomyHint": "调用模型生成项目主线维度与标签，并从 GitHub 拉取 PR；可能产生费用",
			"page.summaryHint": "调用模型重写标题/摘要并分配维度标签；没更新的 session 会跳过，可能产生费用",
			"page.prHint": "从 GitHub 读取项目 PR 列表；不调用模型",
			"page.cardsNote": "点击卡片切换 session；先「生成维度」再「生成摘要」，卡片就会带主线标签和 PR。",
			"page.prNote": "PR 页默认只显示有 session 关联的 PR；可切换「全部项目 PR」。关联来自 turns 里的 PR URL、`PR #123` 文本或 head branch。",
			"page.prTitle": "项目 PR",
			"page.prTitleLinked": "会话关联 PR",
			"page.prScopeLinked": "仅关联会话",
			"page.prScopeAll": "全部项目 PR",
			"page.prScopeHint": "默认只看有 session 关联的 PR",
			"page.prSub": "{count} 个 PR · {open} 个打开 · {merged} 个已合并",
			"page.prSubLinked": "{count} 个关联 PR · {open} 个打开 · {merged} 个已合并",
			"page.prLinkedEmpty": "当前会话还没有关联 PR。",
			"page.prLinkedEmptyHint": "PR 关联来自 session 里的 PR URL、`PR #123` 文本或 head branch。",
			"page.prNoMatches": "没有匹配的 PR。",
			"page.prNoMatchesHint": "换个状态或搜索词试试。",
			"page.prShowAll": "查看全部项目 PR",
			"page.prEmpty": "还没有 PR 信息。",
			"page.prEmptyHint": "点「刷新 PR」从 GitHub 拉取项目 PR 列表。",
			"page.prSearch": "搜索 PR 编号、标题或作者",
			"page.prAll": "全部",
			"page.prOpen": "打开",
			"page.prMerged": "已合并",
			"page.prClosed": "已关闭",
			"page.prUnknown": "未知",
			"page.prNoSessions": "未关联会话",
			"page.prSessions": "{count} 个相关会话",
			"page.untitled": "无标题",
			"page.updatedAt": "更新于 {time}",
			"page.noAuthor": "未知作者",
			"page.graphLoading": "正在读取 DSH_SESSION_GRAPH.md…",
			"page.graphReady": "DSH_SESSION_GRAPH.md · {count} 个会话 · {edges} 条依赖",
			"page.graphMissing": "未找到 DSH_SESSION_GRAPH.md，只显示实时会话。",
			"page.graphError": "读取 DSH_SESSION_GRAPH.md 失败：{message}",
			"page.graphParseError": "DSH_SESSION_GRAPH.md 解析失败：{message}",
			"page.more": "更多",
			"page.openSession": "打开 session",
			"page.summarizeOne": "单独总结这个 session",
			"page.cancel": "取消",
			"page.pickProject": "选择项目",
			"page.pickHint": "选择一个项目，加载该项目的主线维度、会话卡片与 PR 信息",
			"page.chooseProject": "选择项目…",
			"page.noProjects": "没有可用项目，请先在左侧 DSH 添加工作区。",
			"page.switchProject": "切换项目…",
			"page.renderError": "会话地图渲染失败：{message}。打开浏览器 Console 查看详情。",
			"page.unknownSession": "会话不存在",
			"page.depends": "依赖 {count}",
			"page.currentDimension": "当前主线：{name}",
			"page.openPr": "在 GitHub 打开 PR #{number}"
		};

		const en = {
			"meta.title": "Session map",
			"meta.description": "Project sessions as cards with mainline dimensions, tags and PR information.",
			"panel.label": "Session map",
			"page.title": "Session map",
			"page.sub": "{count} sessions · {dimensions} mainlines · {prs} linked PRs",
			"page.countSessionsOne": "{count} session",
			"page.countSessionsMany": "{count} sessions",
			"page.countMainlinesOne": "{count} mainline",
			"page.countMainlinesMany": "{count} mainlines",
			"page.countLinkedPrsOne": "{count} linked PR",
			"page.countLinkedPrsMany": "{count} linked PRs",
			"page.countArchivedOne": "{count} archived",
			"page.countArchivedMany": "{count} archived",
			"page.countCardsOne": "{count} session",
			"page.countCardsMany": "{count} sessions",
			"page.countDependenciesOne": "{count} dependency",
			"page.countDependenciesMany": "{count} dependencies",
			"page.countPrSessionsOne": "{count} linked session",
			"page.countPrSessionsMany": "{count} linked sessions",
			"page.countPrsOne": "{count} PR",
			"page.countPrsMany": "{count} PRs",
			"page.countOpenOne": "{count} open",
			"page.countOpenMany": "{count} open",
			"page.countMergedOne": "{count} merged",
			"page.countMergedMany": "{count} merged",
			"page.justNow": "just now",
			"page.minutesAgo": "{count} min ago",
			"page.hoursAgo": "{count} h ago",
			"page.daysAgo": "{count} d ago",
			"page.graphReadyPrefix": "DSH_SESSION_GRAPH.md",
			"page.archivedCount": "{count} archived",
			"page.showArchived": "Show archived",
			"page.running": "Running",
			"page.active": "Active",
			"page.archived": "Archived",
			"page.fork": "Fork",
			"page.current": "Current",
			"page.empty": "No sessions to show.",
			"page.noMatches": "No matching sessions.",
			"page.cards": "Cards",
			"page.graph": "Knowledge graph",
			"page.graphNote": "The knowledge graph links sessions, tags and PRs. Hover to highlight neighbours, scroll to zoom, drag the background to pan, drag a node to pin it, and click a session to switch. Edit DSH_SESSION_GRAPH.md, then press Refresh.",
			"page.graphSessions": "Sessions",
			"page.graphTags": "Tags",
			"page.graphPrs": "PRs",
			"page.graphArrows": "Arrows",
			"page.graphFocus": "Focus current",
			"page.graphFocusOn": "Focused",
			"page.graphFocusHint": "Show only nodes and links within {depth} hops of the current session",
			"page.graphFit": "Fit",
			"page.graphRelayout": "Relayout",
			"page.graphZoomIn": "Zoom in",
			"page.graphZoomOut": "Zoom out",
			"page.graphEmpty": "No nodes to show.",
			"page.prs": "PRs",
			"page.searchPlaceholder": "Search title, summary, tags or PR",
			"page.dimensions": "Mainline dimensions",
			"page.allSessions": "All sessions",
			"page.uncategorized": "Uncategorized",
			"page.tags": "Tags",
			"page.allTags": "All tags",
			"page.taxonomyMissing": "No taxonomy yet. Use “Generate dimensions” at the bottom of the mainline panel to create mainlines and tags.",
			"page.cardsCount": "{count} sessions",
			"page.noSummary": "No summary yet. Use “Generate summaries” to classify this session.",
			"page.generateTaxonomy": "Generate dimensions",
			"page.generateSummaries": "Generate summaries",
			"page.refresh": "Refresh",
			"page.refreshPrs": "Refresh PRs",
			"page.generating": "Generating…",
			"page.taxonomyRunning": "Generating project dimensions, tags and PRs…",
			"page.summaryRunning": "Generating session summaries and tags…",
			"page.prRunning": "Refreshing PR information…",
			"page.summaryDone": "Updated; reloading the panel…",
			"page.summaryUnavailable": "Summarizer command is unavailable. Update the plugin and restart DSH.",
			"page.summaryNoSession": "No session is available to run the command.",
			"page.summaryFailed": "Command failed: {message}",
			"page.summarySynced": "Synced {count} session title(s)",
			"page.summarySyncFailed": "{count} title sync(s) failed",
			"page.taxonomyHint": "Calls the model for project dimensions and tags, and fetches PRs from GitHub; may cost money",
			"page.summaryHint": "Calls the model to rewrite titles/summaries and assign tags; unchanged sessions are skipped and may cost money",
			"page.prHint": "Reads the project PR list from GitHub; no model call",
			"page.cardsNote": "Click a card to switch sessions. Generate dimensions first, then summaries, to fill in tags and PRs.",
			"page.prNote": "The PR view shows session-linked PRs by default; switch to “All project PRs” for the full catalog. Links come from PR URLs, `PR #123` text or head branches.",
			"page.prTitle": "Project PRs",
			"page.prTitleLinked": "Session PRs",
			"page.prScopeLinked": "Linked sessions",
			"page.prScopeAll": "All project PRs",
			"page.prScopeHint": "Show only PRs linked to a session by default",
			"page.prSub": "{count} PRs · {open} open · {merged} merged",
			"page.prSubLinked": "{count} linked PRs · {open} open · {merged} merged",
			"page.prLinkedEmpty": "No PR is linked to the visible sessions yet.",
			"page.prLinkedEmptyHint": "Links come from PR URLs, `PR #123` text or head branches in session turns.",
			"page.prNoMatches": "No matching PRs.",
			"page.prNoMatchesHint": "Try another state or search term.",
			"page.prShowAll": "Show all project PRs",
			"page.prEmpty": "No PR information yet.",
			"page.prEmptyHint": "Press “Refresh PRs” to fetch the project PR list from GitHub.",
			"page.prSearch": "Search PR number, title or author",
			"page.prAll": "All",
			"page.prOpen": "Open",
			"page.prMerged": "Merged",
			"page.prClosed": "Closed",
			"page.prUnknown": "Unknown",
			"page.prNoSessions": "No linked session",
			"page.prSessions": "{count} linked sessions",
			"page.untitled": "Untitled",
			"page.updatedAt": "Updated {time}",
			"page.noAuthor": "Unknown author",
			"page.graphLoading": "Reading DSH_SESSION_GRAPH.md…",
			"page.graphReady": "DSH_SESSION_GRAPH.md · {count} sessions · {edges} dependencies",
			"page.graphMissing": "DSH_SESSION_GRAPH.md not found; showing live sessions only.",
			"page.graphError": "Failed to read DSH_SESSION_GRAPH.md: {message}",
			"page.graphParseError": "Failed to parse DSH_SESSION_GRAPH.md: {message}",
			"page.more": "More",
			"page.openSession": "Open session",
			"page.summarizeOne": "Summarize this session only",
			"page.cancel": "Cancel",
			"page.pickProject": "Choose a project",
			"page.pickHint": "Choose a project to load its dimensions, session cards and PR information",
			"page.chooseProject": "Choose a project…",
			"page.noProjects": "No projects available. Add a workspace in DSH first.",
			"page.switchProject": "Switch project…",
			"page.renderError": "Session map failed to render: {message}. Check the browser console for details.",
			"page.unknownSession": "Session not found",
			"page.depends": "{count} dependencies",
			"page.currentDimension": "Mainline: {name}",
			"page.openPr": "Open PR #{number} on GitHub"
		};

		const CSS = `
/* Color semantics:
 * session status: running #2f9e44 / active #4c6ef5 / archived #adb5bd
 * dimension accent: DIMENSION_COLORS in JS (indigo, teal, orange, grape, cyan, pink)
 * PR state: open #2f9e44 / merged #6741d9 / closed #c92a2a / unknown #868e96
 */
.dsm-root {
  height: 100%;
  min-height: 420px;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  padding: 24px 28px 16px;
  color: var(--dsw-alias-label-primary, #1f2328);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
}
.dsm-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 10px; }
.dsm-title { margin: 0; font-size: 20px; font-weight: 650; letter-spacing: -.02em; }
.dsm-sub { margin: 4px 0 0; color: var(--dsw-alias-label-tertiary, #8b949e); font-size: 12px; }
.dsm-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0 0 12px; }
.dsm-spacer { flex: 1 1 auto; }
.dsm-btn { appearance: none; border: 1px solid var(--dsw-alias-border-l2, #d8dee4); background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-secondary, #57606a); border-radius: 7px; padding: 4px 9px; font: inherit; font-size: 11px; cursor: pointer; white-space: nowrap; }
.dsm-btn:hover { border-color: var(--dsw-alias-border-l1, #c4cdd9); color: var(--dsw-alias-label-primary, #1f2328); }
.dsm-btn:disabled { opacity: .45; cursor: default; }
.dsm-btn.primary { border-color: #bac8ff; background: #f3f6ff; color: #3b5bdb; font-weight: 600; }
.dsm-picker-root { align-items: center; justify-content: center; }
.dsm-picker { width: min(520px, calc(100% - 40px)); padding: 28px 24px; border: 1px solid var(--dsw-alias-border-l2, #e4e7ec); border-radius: 16px; background: var(--dsw-alias-bg-layer-1, #fff); text-align: center; }
.dsm-picker h1 { margin: 0 0 8px; font-size: 18px; font-weight: 650; }
.dsm-picker p { margin: 0 0 16px; color: var(--dsw-alias-label-tertiary, #8b949e); font-size: 12px; line-height: 1.6; }
.dsm-picker select, .dsm-project-select { appearance: none; border: 1px solid var(--dsw-alias-border-l2, #d8dee4); background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #1f2328); border-radius: 8px; padding: 7px 30px 7px 10px; font: inherit; font-size: 12px; max-width: 100%; cursor: pointer; }
.dsm-picker select { min-width: 220px; }
.dsm-project-select { max-width: 180px; }
.dsm-search { appearance: none; border: 1px solid var(--dsw-alias-border-l2, #d8dee4); background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #1f2328); border-radius: 7px; padding: 5px 9px; font: inherit; font-size: 11px; width: 240px; max-width: 100%; }
.dsm-search:focus { outline: 2px solid #bac8ff; outline-offset: 0; }
.dsm-toggle { display: flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-secondary, #57606a); font-size: 11px; cursor: pointer; user-select: none; white-space: nowrap; }
.dsm-legend { display: flex; flex-wrap: wrap; gap: 8px; color: var(--dsw-alias-label-tertiary, #8b949e); font-size: 10.5px; }
.dsm-legend span { display: inline-flex; align-items: center; gap: 4px; }
.dsm-legend i { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
.dsm-legend i.running { background: #2f9e44; }
.dsm-legend i.active { background: #4c6ef5; }
.dsm-legend i.archived { background: #adb5bd; }
.dsm-seg { display: inline-flex; gap: 2px; padding: 2px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2, #f0f2f5); }
.dsm-seg button { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary, #57606a); border-radius: 6px; padding: 4px 9px; font: inherit; font-size: 11px; cursor: pointer; }
.dsm-seg button.on { background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #1f2328); font-weight: 650; box-shadow: 0 1px 2px rgba(16, 24, 40, .08); }
.dsm-source { max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-tertiary, #8b949e); font-size: 11px; }
.dsm-source.is-error { color: #c92a2a; }
.dsm-summary-status { max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-tertiary, #8b949e); font-size: 11px; }
.dsm-summary-status.is-error { color: #c92a2a; }
.dsm-body { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 14px; }
.dsm-facets { display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--dsw-alias-border-l2, #e4e7ec); border-radius: 12px; background: var(--dsw-alias-bg-layer-1, #fff); }
.dsm-facets-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 10px; }
.dsm-facets-title { margin: 0 4px 8px; overflow: hidden; color: var(--dsw-alias-label-tertiary, #8b949e); font-size: 10.5px; font-weight: 650; letter-spacing: .06em; text-overflow: ellipsis; text-transform: uppercase; white-space: nowrap; }
.dsm-facets-foot { flex: none; padding: 8px 10px 10px; border-top: 1px solid var(--dsw-alias-border-l2, #f0f2f5); }
.dsm-facet-action { display: block; width: 100%; appearance: none; border: 1px solid #d0d7ff; border-radius: 6px; background: #f3f6ff; color: #3b5bdb; padding: 5px 6px; font: inherit; font-size: 10.5px; font-weight: 600; text-align: left; white-space: nowrap; cursor: pointer; }
.dsm-facet-action:hover { background: #e7edff; }
.dsm-facet-action:disabled { opacity: .45; cursor: default; }
.dsm-facet { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 8px; border: 0; border-radius: 8px; background: transparent; color: inherit; font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
.dsm-facet:hover { background: var(--dsw-alias-bg-layer-2, #f7f8fa); }
.dsm-facet.is-active { background: #eef2ff; color: #3b5bdb; font-weight: 600; }
.dsm-facet-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.dsm-facet-name { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsm-facet-count { color: var(--dsw-alias-label-tertiary, #8b949e); font-size: 10.5px; font-variant-numeric: tabular-nums; }
.dsm-tag-filter { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--dsw-alias-border-l2, #e4e7ec); }
.dsm-tag-title { width: 100%; margin: 0 2px 2px; color: var(--dsw-alias-label-tertiary, #8b949e); font-size: 10.5px; }
.dsm-tag { appearance: none; border: 1px solid var(--dsw-alias-border-l2, #d8dee4); background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-secondary, #57606a); border-radius: 999px; padding: 1px 7px; font: inherit; font-size: 10.5px; cursor: pointer; }
.dsm-tag:hover { border-color: var(--dsw-alias-border-l1, #c4cdd9); }
.dsm-tag.is-active { border-color: #bac8ff; background: #eef2ff; color: #3b5bdb; font-weight: 600; }
.dsm-facet-hint { margin: 10px 4px 0; color: var(--dsw-alias-label-tertiary, #8b949e); font-size: 11px; line-height: 1.5; }
.dsm-cards { min-width: 0; overflow: auto; padding-right: 4px; }
.dsm-cards-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; margin: 0 0 10px; color: var(--dsw-alias-label-tertiary, #8b949e); font-size: 11px; }
.dsm-filter-note { color: #3b5bdb; }
.dsm-card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(270px, 1fr)); gap: 12px; align-items: start; }
.dsm-card { position: relative; display: flex; flex-direction: column; gap: 8px; min-height: 170px; padding: 14px; border: 1px solid var(--dsw-alias-border-l2, #e4e7ec); border-top: 3px solid var(--dsm-accent, #dee2e6); border-radius: 12px; background: var(--dsm-bg, var(--dsw-alias-bg-layer-1, #fff)); cursor: pointer; transition: border-color .12s ease, box-shadow .12s ease, transform .12s ease; }
.dsm-card:hover { border-color: var(--dsw-alias-border-l1, #c4cdd9); box-shadow: 0 4px 14px rgba(16, 24, 40, .07); transform: translateY(-1px); }
.dsm-card.is-current { box-shadow: 0 0 0 2px var(--dsm-accent, #4c6ef5); }
.dsm-card.is-archived { opacity: .55; cursor: default; border-style: dashed; transform: none; box-shadow: none; }
.dsm-card-head { display: flex; align-items: flex-start; gap: 8px; padding-right: 22px; }
.dsm-dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 5px; flex: none; }
.dsm-dot.running { background: #2f9e44; }
.dsm-dot.active { background: #4c6ef5; }
.dsm-dot.archived { background: #adb5bd; }
.dsm-card-title { margin: 0; font-size: 13.5px; font-weight: 650; line-height: 1.4; word-break: break-word; }
.dsm-card-badge { flex: none; border: 1px solid #bac8ff; border-radius: 999px; padding: 0 6px; color: #4c6ef5; font-size: 10px; font-weight: 650; }
.dsm-card-menu { position: absolute; top: 8px; right: 8px; width: 22px; height: 22px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-tertiary, #8b949e); font-size: 15px; line-height: 1; cursor: pointer; }
.dsm-card-menu:hover { background: var(--dsw-alias-bg-layer-2, #f7f8fa); }
.dsm-card-summary { margin: 0; color: var(--dsw-alias-label-secondary, #57606a); font-size: 12px; line-height: 1.55; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.dsm-card-summary.is-empty { color: var(--dsw-alias-label-tertiary, #8b949e); font-style: italic; }
.dsm-card-dims { display: flex; flex-direction: column; gap: 5px; }
.dsm-card-dim { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.dsm-card-dim-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.dsm-card-dim-name { margin-right: 2px; color: var(--dsw-alias-label-secondary, #57606a); font-size: 11px; font-weight: 600; }
.dsm-chip { display: inline-flex; align-items: center; padding: 1px 6px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2, #f1f3f5); color: var(--dsw-alias-label-secondary, #57606a); font-size: 10.5px; line-height: 1.6; }
.dsm-card-dims.is-empty { color: var(--dsw-alias-label-tertiary, #8b949e); font-size: 11px; }
.dsm-card-prs { display: flex; flex-wrap: wrap; gap: 5px; }
.dsm-pr-chip { display: inline-flex; align-items: center; padding: 1px 6px; border: 1px solid transparent; border-radius: 5px; font-size: 10.5px; text-decoration: none; }
.dsm-pr-chip.open { border-color: #b2f2bb; background: #ebfbee; color: #2f9e44; }
.dsm-pr-chip.merged { border-color: #d0bfff; background: #f3f0ff; color: #6741d9; }
.dsm-pr-chip.closed { border-color: #ffc9c9; background: #fff5f5; color: #c92a2a; }
.dsm-pr-chip.unknown { border-color: #dee2e6; background: #f1f3f5; color: #868e96; }
.dsm-card-foot { display: flex; flex-wrap: wrap; gap: 6px; margin-top: auto; padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l2, #f0f2f5); color: var(--dsw-alias-label-tertiary, #8b949e); font-size: 10.5px; }
.dsm-card-foot span + span::before { content: "·"; margin-right: 6px; color: #ced4da; }
.dsm-card-time { margin-left: auto; }
.dsm-pr-panel { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--dsw-alias-border-l2, #e4e7ec); border-radius: 12px; background: var(--dsw-alias-bg-layer-1, #fff); }
.dsm-pr-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--dsw-alias-border-l2, #f0f2f5); }
.dsm-pr-head h2 { margin: 0; font-size: 15px; font-weight: 650; }
.dsm-pr-sub { margin: 3px 0 0; color: var(--dsw-alias-label-tertiary, #8b949e); font-size: 11px; }
.dsm-pr-scope { display: flex; align-items: center; gap: 6px; }
.dsm-pr-scope .dsm-seg button { white-space: nowrap; }
.dsm-pr-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 10px 16px; border-bottom: 1px solid var(--dsw-alias-border-l2, #f0f2f5); }
.dsm-pr-filter { appearance: none; border: 1px solid var(--dsw-alias-border-l2, #d8dee4); background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-secondary, #57606a); border-radius: 999px; padding: 2px 8px; font: inherit; font-size: 10.5px; cursor: pointer; }
.dsm-pr-filter.is-active { border-color: #bac8ff; background: #eef2ff; color: #3b5bdb; font-weight: 600; }
.dsm-pr-list { flex: 1 1 auto; overflow: auto; }
.dsm-pr-row { display: grid; grid-template-columns: 64px minmax(0, 1fr) minmax(140px, 260px); gap: 12px; align-items: start; padding: 10px 16px; border-bottom: 1px solid var(--dsw-alias-border-l2, #f0f2f5); }
.dsm-pr-row:hover { background: var(--dsw-alias-bg-layer-2, #f7f8fa); }
.dsm-pr-state { display: inline-flex; align-items: center; justify-content: center; padding: 1px 6px; border-radius: 999px; font-size: 10px; font-weight: 650; }
.dsm-pr-state.open { background: #ebfbee; color: #2f9e44; }
.dsm-pr-state.merged { background: #f3f0ff; color: #6741d9; }
.dsm-pr-state.closed { background: #fff5f5; color: #c92a2a; }
.dsm-pr-state.unknown { background: #f1f3f5; color: #868e96; }
.dsm-pr-main { min-width: 0; }
.dsm-pr-title { color: var(--dsw-alias-label-primary, #1f2328); font-size: 12.5px; font-weight: 600; text-decoration: none; }
.dsm-pr-title:hover { text-decoration: underline; }
.dsm-pr-meta { margin-top: 3px; color: var(--dsw-alias-label-tertiary, #8b949e); font-size: 10.5px; }
.dsm-pr-sessions { display: flex; flex-wrap: wrap; gap: 4px; justify-content: flex-end; }
.dsm-session-chip { appearance: none; border: 1px solid var(--dsw-alias-border-l2, #d8dee4); background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-secondary, #57606a); border-radius: 999px; padding: 1px 7px; font: inherit; font-size: 10.5px; cursor: pointer; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsm-session-chip:hover { border-color: #bac8ff; color: #3b5bdb; }
.dsm-pr-none { color: var(--dsw-alias-label-tertiary, #8b949e); font-size: 10.5px; }
.dsm-pr-empty { flex: 1 1 auto; display: grid; place-items: center; min-height: 260px; padding: 24px; color: var(--dsw-alias-label-tertiary, #8b949e); text-align: center; }
.dsm-pr-empty h3 { margin: 0 0 6px; color: var(--dsw-alias-label-secondary, #57606a); font-size: 14px; }
.dsm-pr-empty p { margin: 0 0 12px; font-size: 12px; }
/* Knowledge graph: deliberately a dark, Obsidian-like canvas even in the
 * light theme, so graph colour encodes data instead of the page chrome. */
.dsm-graph { position: relative; flex: 1 1 auto; min-height: 360px; overflow: hidden; border: 1px solid #262b35; border-radius: 14px; background: radial-gradient(circle at 50% 42%, #1d222b 0%, #121419 68%); }
.dsm-graph svg { position: absolute; inset: 0; display: block; width: 100%; height: 100%; touch-action: none; cursor: grab; user-select: none; }
.dsm-graph.is-panning svg { cursor: grabbing; }
.dsm-graph text { font-family: inherit; }
.dsm-graph-link { stroke: #495262; stroke-width: 1; opacity: .38; vector-effect: non-scaling-stroke; transition: opacity .12s ease, stroke .12s ease; }
.dsm-graph-link.dependency { stroke: #9aa4b6; opacity: .5; }
.dsm-graph-link.tag { stroke-dasharray: 2 4; opacity: .28; }
.dsm-graph-link.pr { stroke: #7c6fbf; opacity: .36; }
.dsm-graph.is-hovering .dsm-graph-link.is-dimmed { opacity: .06; }
.dsm-graph-link.is-active { opacity: .9; stroke-width: 1.5; }
.dsm-graph-node { cursor: pointer; }
.dsm-graph-node.kind-tag, .dsm-graph-node.kind-pr { cursor: default; }
.dsm-graph-node.is-archived { opacity: .38; cursor: default; }
.dsm-graph-node.is-dimmed { opacity: .16; }
.dsm-graph-node.is-hover .dsm-graph-dot { stroke: #f8fafc; stroke-width: 1.8; }
.dsm-graph-node.is-neighbor .dsm-graph-dot { stroke: #cbd5e1; }
.dsm-graph-dot { stroke: #121419; stroke-width: 1.2; transition: stroke .12s ease, opacity .12s ease; }
.dsm-graph-node:focus-visible { outline: none; }
.dsm-graph-node:focus-visible .dsm-graph-dot { stroke: #f8fafc; stroke-width: 2; }
.dsm-graph-ring { fill: none; stroke: #f8fafc; stroke-width: 1.1; opacity: .9; }
.dsm-graph-run { fill: none; stroke: #51cf66; stroke-width: 1; opacity: .8; }
.dsm-graph-label { font-size: 10px; fill: #d7dce5; paint-order: stroke; stroke: #121419; stroke-width: 2.5px; stroke-linejoin: round; pointer-events: none; opacity: 1; transition: opacity .15s ease; }
.dsm-graph-node.kind-tag .dsm-graph-label, .dsm-graph-node.kind-pr .dsm-graph-label { font-size: 9px; fill: #aeb7c6; }
.dsm-graph-node.is-hub .dsm-graph-label { font-size: 11px; font-weight: 600; }
.dsm-graph[data-zoom="mid"] .dsm-graph-node.kind-tag .dsm-graph-label,
.dsm-graph[data-zoom="mid"] .dsm-graph-node.kind-pr .dsm-graph-label { opacity: 0; }
.dsm-graph.is-dense[data-zoom="mid"] .dsm-graph-node.kind-session:not(.is-current):not(.is-hub):not(.is-hover):not(.is-neighbor) .dsm-graph-label { opacity: 0; }
.dsm-graph[data-zoom="mid"] .dsm-graph-node.is-hover .dsm-graph-label,
.dsm-graph[data-zoom="mid"] .dsm-graph-node.is-neighbor .dsm-graph-label { opacity: 1; }
.dsm-graph[data-zoom="far"] .dsm-graph-label { opacity: 0; }
.dsm-graph[data-zoom="far"] .dsm-graph-node.is-hover .dsm-graph-label,
.dsm-graph[data-zoom="far"] .dsm-graph-node.is-neighbor .dsm-graph-label,
.dsm-graph[data-zoom="far"] .dsm-graph-node.is-current .dsm-graph-label { opacity: 1; }
.dsm-graph-toolbar { position: absolute; z-index: 2; top: 10px; left: 10px; display: flex; flex-wrap: wrap; align-items: center; gap: 2px; max-width: calc(100% - 20px); padding: 4px; border: 1px solid rgba(255, 255, 255, .09); border-radius: 10px; background: rgba(18, 20, 25, .74); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); }
.dsm-graph-toolbar button { appearance: none; border: 0; border-radius: 6px; background: transparent; color: #98a2b3; padding: 4px 7px; font: inherit; font-size: 10.5px; line-height: 1.4; white-space: nowrap; cursor: pointer; }
.dsm-graph-toolbar button:hover { background: rgba(255, 255, 255, .08); color: #e6eaf2; }
.dsm-graph-toolbar button.on { background: #2b3444; color: #c7d2fe; font-weight: 600; }
.dsm-graph-toolbar button:disabled { opacity: .4; cursor: default; }
.dsm-graph-sep { width: 1px; height: 14px; margin: 0 2px; background: rgba(255, 255, 255, .1); }
.dsm-graph-legend { position: absolute; left: 12px; bottom: 10px; z-index: 2; display: flex; flex-wrap: wrap; gap: 3px 10px; max-width: calc(100% - 24px); padding: 5px 9px; border-radius: 8px; background: rgba(18, 20, 25, .58); color: #8f99a8; font-size: 10px; line-height: 1.6; pointer-events: none; }
.dsm-graph-legend span { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.dsm-graph-legend i { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
.dsm-graph-legend i.tag { border-radius: 2px; }
.dsm-graph-legend i.pr { border-radius: 1px; }
.dsm-graph-empty { flex: 1 1 auto; display: grid; place-items: center; min-height: 360px; border: 1px dashed #343b48; border-radius: 14px; background: #14161b; color: #8f99a8; font-size: 12px; }
.dsm-empty { flex: 1 1 auto; display: grid; place-items: center; min-height: 280px; color: var(--dsw-alias-label-tertiary, #8b949e); border: 1px dashed var(--dsw-alias-border-l2, #d8dee4); border-radius: 14px; }
.dsm-note { flex: none; margin: 10px 0 0; color: var(--dsw-alias-label-tertiary, #8b949e); font-size: 11px; line-height: 1.6; }
.dsm-dialog-backdrop { position: fixed; inset: 0; z-index: 80; display: grid; place-items: center; background: rgba(15, 23, 42, .28); }
.dsm-dialog { width: min(380px, calc(100vw - 40px)); box-sizing: border-box; padding: 18px; border: 1px solid var(--dsw-alias-border-l2, #e4e7ec); border-radius: 14px; background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #1f2328); box-shadow: 0 18px 50px rgba(15, 23, 42, .22); }
.dsm-dialog h3 { margin: 0 0 4px; font-size: 15px; line-height: 1.4; }
.dsm-dialog p { margin: 0 0 14px; color: var(--dsw-alias-label-tertiary, #8b949e); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
.dsm-dialog button { display: block; width: 100%; margin-top: 8px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l2, #d8dee4); border-radius: 8px; background: var(--dsw-alias-bg-layer-1, #fff); color: inherit; font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
.dsm-dialog button:hover { background: var(--dsw-alias-bg-layer-2, #f7f8fa); }
.dsm-dialog button.primary { border-color: #4c6ef5; color: #3b5bdb; font-weight: 600; }
.dsm-dialog button:disabled { opacity: .5; cursor: default; }
@media (max-width: 860px) {
  .dsm-root { padding: 18px 14px 12px; }
  .dsm-body { grid-template-columns: 1fr; }
  .dsm-facets { max-height: 210px; }
  .dsm-pr-row { grid-template-columns: 56px minmax(0, 1fr); }
  .dsm-pr-sessions { grid-column: 2; justify-content: flex-start; }
  .dsm-search { width: 100%; }
  .dsm-graph-toolbar { top: 8px; left: 8px; gap: 0; }
  .dsm-graph-toolbar button { padding: 4px 5px; font-size: 10px; }
  .dsm-graph-legend { display: none; }
  .dsm-graph { min-height: 300px; }
}
`;

		function installStyles() {
			if (typeof document === "undefined") return;
			const marker = "dsh-session-graph/styles";
			const existing = document.querySelector('style[data-dsm="' + marker + '"]');
			if (existing !== null) {
				existing.textContent = CSS;
				return;
			}
			const tag = document.createElement("style");
			tag.dataset.dsm = marker;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		function apply(ctx) {
			installStyles();
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "session-graph: dictionaries");
			const t = ctx.locale.bind(NS);
			const uiWorkspace = ctx.get("uiWorkspace");
			if (uiWorkspace === undefined) throw new Error("session-graph: uiWorkspace service is unavailable");
			const sessions = ctx.get("sessions");
			const workspaceFiles = ctx.remote.workspaceFiles;
			const sessionRemote = ctx.remote === undefined || ctx.remote === null ? undefined : ctx.remote.session;
			const renameSession = sessionRemote === undefined || typeof sessionRemote.rename !== "function"
				? undefined
				: async (sessionId, title) => {
					const result = await sessionRemote.rename({ sessionId, title });
					if (result === undefined || !result.ok) {
						const error = result === undefined ? undefined : result.error;
						throw new Error(error === undefined ? "session rename failed" : (error.message || error.code));
					}
					return result.value;
				};
			const refreshSessions = sessions === undefined || sessions === null || typeof sessions.refresh !== "function"
				? undefined
				: () => sessions.refresh();

			ctx.slots.inject("main", () => ctx.slots.register({
				name: "main",
				key: PANEL_ID,
				locale: NS,
				inject: () => ({
					openSession: (sessionId) => uiWorkspace.openSession(sessionId),
					workspaceFiles,
					commands: ctx.remote.commands,
					renameSession,
					refreshSessions
				})
			}, PanelRoot));

			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: PANEL_ID,
				order: 10,
				locale: NS,
				label: () => t("panel.label")
			}, SessionGraphIcon));
		}

		function SessionGraphIcon({ size = 16 }) {
			return h("svg", {
				width: size,
				height: size,
				viewBox: "0 0 16 16",
				fill: "none",
				"aria-hidden": true
			}, [
				h("path", {
					key: "links",
					d: "M8 6.6 4.7 10.3M8.7 7.2l3 3.2",
					stroke: "currentColor",
					strokeWidth: 1.2,
					strokeLinecap: "round"
				}),
				h("circle", { key: "top", cx: 8, cy: 4.5, r: 2.1, fill: "currentColor" }),
				h("circle", { key: "left", cx: 3.5, cy: 11.4, r: 1.9, fill: "currentColor" }),
				h("circle", { key: "right", cx: 12.5, cy: 11.4, r: 1.9, fill: "currentColor" })
			]);
		}

		function ProjectPicker({ workspaces, onSelect, tr }) {
			const items = workspaces.items || [];
			return h("div", { className: "dsm-picker" }, [
				h("h1", { key: "title" }, tr("page.pickProject")),
				h("p", { key: "hint" }, tr("page.pickHint")),
				items.length === 0
					? h("p", { key: "empty" }, tr("page.noProjects"))
					: h("select", {
						key: "select",
						value: "",
						"aria-label": tr("page.pickProject"),
						onChange: (event) => {
							if (event.target.value !== "") onSelect(event.target.value);
						}
					}, [
						h("option", { key: "choose", value: "" }, tr("page.chooseProject")),
						...items.map((item) => h("option", {
							key: item.workspaceId,
							value: item.workspaceId
						}, item.title || item.path))
					])
			]);
		}

		const PanelErrorBoundary = React.Component === undefined ? null : class PanelErrorBoundary extends React.Component {
			constructor(props) {
				super(props);
				this.state = { error: null };
			}

			static getDerivedStateFromError(error) {
				return { error };
			}

			componentDidCatch(error, info) {
				console.error("session-graph: render failed", error, info);
			}

			render() {
				if (this.state.error !== null) {
					const t = typeof this.props.t === "function" ? this.props.t : null;
					const message = String(this.state.error && this.state.error.message || this.state.error);
					return h("div", { className: "dsm-root" },
						h("div", { className: "dsm-empty" }, t === null ? message : t("page.renderError", { message }))
					);
				}
				return this.props.children === undefined ? null : this.props.children;
			}
		};

		function PanelRoot(props) {
			return PanelErrorBoundary === null
				? h(SessionGraphPage, props)
				: h(PanelErrorBoundary, { t: props.t }, h(SessionGraphPage, props));
		}

		function SessionGraphPage({ useSessions, useWorkspaces, openSession, workspaceFiles, commands, renameSession, refreshSessions, t }) {
			const tr = typeof t === "function" ? t : (key) => key;
			const list = (useSessions && useSessions((state) => state)) || EMPTY_LIST;
			const workspaces = (useWorkspaces && useWorkspaces((state) => state)) || EMPTY_WORKSPACES;
			const [projectId, setProjectId] = React.useState(readStoredProject);
			const [showArchived, setShowArchived] = React.useState(false);
			const [reloadKey, setReloadKey] = React.useState(0);
			const [graphState, setGraphState] = React.useState(EMPTY_GRAPH);
			const [summaryBusy, setSummaryBusy] = React.useState(false);
			const [summaryAction, setSummaryAction] = React.useState("");
			const [summaryMessage, setSummaryMessage] = React.useState("");
			const [menuSessionId, setMenuSessionId] = React.useState(null);
			const [view, setView] = React.useState("cards");
			const [selectedDimension, setSelectedDimension] = React.useState("");
			const [selectedTag, setSelectedTag] = React.useState("");
			const [query, setQuery] = React.useState("");

			const archived = new Set(workspaces.archivedSessionIds || []);
			const projectItems = workspaces.items || [];
			const selectedProject = projectItems.find((item) => item.workspaceId === projectId);
			const projectPath = selectedProject === undefined ? "" : String(selectedProject.path || "").replace(/\/+$/, "");

			const allRows = (list.ids || [])
				.map((id) => list.byId[id])
				.filter((row) => row !== undefined)
				.filter((row) => !row.blank)
				// Subagent children stay out of the session map; user forks are ordinary
				// sessions and must remain visible. Native DSH uses the same rule.
				.filter((row) => row.origin !== "subagent");

			const projectRows = selectedProject === undefined ? [] : allRows.filter((row) => inProject(row, selectedProject, projectPath));
			const rows = projectRows.filter((row) => showArchived || !archived.has(row.id));
			const projectArchivedCount = projectRows.filter((row) => archived.has(row.id)).length;
			const currentRow = allRows.find((row) => row.retainedBy && row.retainedBy.mainView) ||
				allRows.find((row) => !archived.has(row.id)) ||
				allRows[0];
			const currentSessionId = currentRow === undefined ? undefined : currentRow.id;
			const projectReadRow = selectedProject === undefined ? undefined :
				allRows.find((row) => !archived.has(row.id) && inProject(row, selectedProject, projectPath)) ||
				allRows.find((row) => inProject(row, selectedProject, projectPath));
			const readSessionId = projectReadRow !== undefined ? projectReadRow.id : currentSessionId;
			const canSummarize = currentSessionId !== undefined || projectReadRow !== undefined;
			const filePath = projectPath === "" ? "" : projectPath + "/DSH_SESSION_GRAPH.md";

			const rowIds = new Set(rows.map((row) => row.id));
			const entryBySession = new Map((graphState.entries || []).map((entry) => [entry.session, entry]));
			const graphTasks = rows.map((row) => {
				const entry = entryBySession.get(row.id);
				// A user fork inherits its source session; keep that structural link visible
				// even when DSH_SESSION_GRAPH.md has no explicit entry for the fork yet.
				const inherited = row.parentId === undefined ? [] : [row.parentId];
				const dependencies = [];
				for (const id of (entry === undefined ? [] : entry.dependsOn || []).concat(inherited)) {
					if (id !== row.id && rowIds.has(id) && !dependencies.includes(id)) dependencies.push(id);
				}
				return {
					id: row.id,
					title: entry !== undefined && entry.title !== "" ? entry.title : (row.displayTitle || row.id),
					displayTitle: displayTaskTitle({
						title: entry !== undefined && entry.title !== "" ? entry.title : (row.displayTitle || row.id),
						pullRequests: entry === undefined || entry.pullRequests === undefined ? [] : entry.pullRequests
					}),
					summary: entry === undefined ? "" : entry.summary,
					session: row.id,
					status: row.running ? "running" : "active",
					dependsOn: dependencies,
					dimensions: entry === undefined || entry.dimensions === undefined || entry.dimensions === null ? {} : entry.dimensions,
					pullRequests: entry === undefined || entry.pullRequests === undefined || entry.pullRequests === null ? [] : entry.pullRequests,
					updatedAt: row.updatedAt || 0
				};
			});

			const linkedPrNumbers = new Set();
			for (const task of graphTasks) {
				for (const number of task.pullRequests) linkedPrNumbers.add(number);
			}

			const taxonomy = graphState.taxonomy === undefined ? { dimensions: [] } : graphState.taxonomy;
			const dimensions = Array.isArray(taxonomy.dimensions) ? taxonomy.dimensions : [];
			const pullRequests = Array.isArray(graphState.pullRequests) ? graphState.pullRequests : [];
			const prByNumber = new Map(pullRequests.map((pr) => [pr.number, pr]));

			const dimensionCounts = new Map(dimensions.map((dimension) => [dimension.id, 0]));
			let uncategorizedCount = 0;
			for (const task of graphTasks) {
				let tagged = false;
				for (const dimension of dimensions) {
					const tags = task.dimensions[dimension.id];
					if (Array.isArray(tags) && tags.length > 0) {
						tagged = true;
						dimensionCounts.set(dimension.id, (dimensionCounts.get(dimension.id) || 0) + 1);
					}
				}
				if (!tagged) uncategorizedCount += 1;
			}

			const dimensionIds = new Set(dimensions.map((dimension) => dimension.id));
			const effectiveDimension = selectedDimension === "" || selectedDimension === "__none__" ||
				dimensionIds.has(selectedDimension) ? selectedDimension : "";
			const activeDimension = dimensions.find((dimension) => dimension.id === effectiveDimension);
			const tagCounts = new Map((activeDimension === undefined ? [] : activeDimension.tags).map((tag) => [tag.id, 0]));
			if (activeDimension !== undefined) {
				for (const task of graphTasks) {
					for (const tagId of task.dimensions[activeDimension.id] || []) {
						if (tagCounts.has(tagId)) tagCounts.set(tagId, tagCounts.get(tagId) + 1);
					}
				}
			}
			const effectiveTag = activeDimension !== undefined &&
				activeDimension.tags.some((tag) => tag.id === selectedTag) ? selectedTag : "";

			const normalizedQuery = query.trim().toLowerCase();
			const filteredTasks = graphTasks.filter((task) => {
				if (effectiveDimension === "__none__") {
					const tagged = dimensions.some((dimension) => {
						const tags = task.dimensions[dimension.id];
						return Array.isArray(tags) && tags.length > 0;
					});
					if (tagged) return false;
				} else if (effectiveDimension !== "") {
					const tags = task.dimensions[effectiveDimension];
					if (!Array.isArray(tags) || tags.length === 0) return false;
					if (effectiveTag !== "" && !tags.includes(effectiveTag)) return false;
				}
				if (normalizedQuery === "") return true;
				const tagNames = [];
				for (const dimension of dimensions) {
					tagNames.push(dimension.name);
					for (const tagId of task.dimensions[dimension.id] || []) {
						const tag = dimension.tags.find((item) => item.id === tagId);
						if (tag !== undefined) tagNames.push(tag.name);
					}
				}
				const prLabels = task.pullRequests.map((number) => {
					const pr = prByNumber.get(number);
					return "#" + number + " " + (pr === undefined ? "" : pr.title);
				});
				const haystack = [task.title, task.summary, task.session].concat(tagNames, prLabels).join(" ").toLowerCase();
				return haystack.includes(normalizedQuery);
			}).sort((left, right) => {
				const rank = (task) => task.session === currentSessionId ? 0 : task.status === "running" ? 1 : 2;
				return rank(left) - rank(right) || (right.updatedAt || 0) - (left.updatedAt || 0);
			});

			const dependencyEdgeCount = countDependencyEdges(graphTasks);

			const selectProject = (nextProjectId) => {
				setProjectId(nextProjectId);
				storeProject(nextProjectId);
			};

			const shortMessage = (text) => {
				const value = String(text || "").trim();
				return value.length > 320 ? value.slice(-320) : value;
			};

			const syncSummaryTitles = (beforeEntries, includeSession) => syncSessionTitles({
				beforeEntries,
				workspaceFiles,
				readSessionId,
				filePath,
				byId: list.byId,
				renameSession,
				refreshSessions,
				includeSession
			});

			const runSummaryCommand = async (targetSessionId, command, rawInput, action) => {
				if (commands === undefined || typeof commands.execute !== "function") {
					setSummaryMessage(tr("page.summaryUnavailable"));
					return;
				}
				if (targetSessionId === undefined) {
					setSummaryMessage(tr("page.summaryNoSession"));
					return;
				}
				const beforeEntries = graphState.phase === "ready" ? graphState.entries : undefined;
				setSummaryBusy(true);
				setSummaryAction(action || "");
				setSummaryMessage(action === "taxonomy" ? tr("page.taxonomyRunning") : action === "prs" ? tr("page.prRunning") : tr("page.summaryRunning"));
				try {
					const line = rawInput !== undefined && rawInput.trim() !== "" ? `${command} ${rawInput.trim()}` : command;
					const result = await commands.execute(targetSessionId, line, []);
					if (result === undefined) {
						setSummaryMessage(tr("page.summaryUnavailable"));
						return;
					}
					if (!result.ok) {
						const error = result.error === undefined ? "unknown error" : (result.error.message || result.error.code);
						setSummaryMessage(tr("page.summaryFailed", { message: error }));
						return;
					}
					const outcome = result.value === undefined ? undefined : result.value.result;
					if (outcome === undefined) {
						setSummaryMessage(tr("page.summaryDone"));
						setReloadKey((value) => value + 1);
						return;
					}
					if (outcome.kind === "error") {
						setSummaryMessage(shortMessage(outcome.text || "error"));
						// The command may still have written partial results before a
						// model call failed; reload so the panel shows them.
						setReloadKey((value) => value + 1);
						return;
					}
					let syncNote = "";
					if (action === "sessions") {
						let sync = { synced: 0, failed: 0 };
						try {
							sync = await syncSummaryTitles(beforeEntries, command === "/summarize-session" ? targetSessionId : undefined);
						} catch (error) {
							console.warn("session-graph: title sync failed", error);
						}
						const parts = [];
						if (sync.synced > 0) parts.push(tr("page.summarySynced", { count: sync.synced }));
						if (sync.failed > 0) parts.push(tr("page.summarySyncFailed", { count: sync.failed }));
						if (parts.length > 0) syncNote = " · " + parts.join(" · ");
					}
					setSummaryMessage(shortMessage(outcome.text || tr("page.summaryDone")) + syncNote);
					setReloadKey((value) => value + 1);
				} catch (error) {
					setSummaryMessage(tr("page.summaryFailed", { message: String(error.message || error) }));
				} finally {
					setSummaryBusy(false);
					setSummaryAction("");
				}
			};

			const summarizeProject = () => {
				void runSummaryCommand(currentSessionId !== undefined ? currentSessionId : (projectReadRow === undefined ? undefined : projectReadRow.id), "/summarize-project", projectPath, "sessions");
			};

			const generateTaxonomy = () => {
				void runSummaryCommand(currentSessionId !== undefined ? currentSessionId : (projectReadRow === undefined ? undefined : projectReadRow.id), "/summarize-taxonomy", projectPath, "taxonomy");
			};

			const refreshPullRequests = () => {
				void runSummaryCommand(currentSessionId !== undefined ? currentSessionId : (projectReadRow === undefined ? undefined : projectReadRow.id), "/summarize-prs", projectPath, "prs");
			};

			const summarizeOne = (sessionId) => {
				setMenuSessionId(null);
				void runSummaryCommand(sessionId, "/summarize-session", "", "sessions");
			};

			React.useEffect(() => {
				setShowArchived(false);
				setSummaryMessage("");
				setSummaryAction("");
				setMenuSessionId(null);
				setView("cards");
				setSelectedDimension("");
				setSelectedTag("");
				setQuery("");
				setGraphState({ ...EMPTY_GRAPH, phase: selectedProject === undefined ? "idle" : "loading" });
			}, [projectId]);

			React.useEffect(() => {
				let disposed = false;
				const controller = typeof AbortController === "function" ? new AbortController() : null;
				const canRead = selectedProject !== undefined && readSessionId !== undefined && filePath !== "" &&
					workspaceFiles !== undefined && typeof workspaceFiles.read === "function";
				if (!canRead) {
					setGraphState({ ...EMPTY_GRAPH, phase: selectedProject === undefined ? "idle" : "missing" });
					return () => {
						disposed = true;
						if (controller !== null) controller.abort();
					};
				}
				setGraphState({ ...EMPTY_GRAPH, phase: "loading" });
				try {
					// workspaceFiles defaults to maxLines = 5000 and rejects larger pages.
					workspaceFiles.read(readSessionId, filePath, { offset: 1, limit: 5000 }, controller === null ? undefined : controller.signal)
						.then((result) => {
							if (disposed) return;
							if (!result.ok) {
								const code = result.error === undefined ? "" : result.error.code;
								const message = result.error === undefined ? "" : result.error.message;
								setGraphState({
									...EMPTY_GRAPH,
									phase: code === "workspace-file/not-found" ? "missing" : "error",
									error: message || code || "unknown error"
								});
								return;
							}
							try {
								const parsed = parseSessionGraph(result.value.text);
								setGraphState({
									...EMPTY_GRAPH,
									phase: "ready",
									entries: parsed.entries,
									title: parsed.title,
									taxonomy: parsed.taxonomy,
									pullRequests: parsed.pullRequests,
									repo: parsed.repo
								});
							} catch (error) {
								setGraphState({
									...EMPTY_GRAPH,
									phase: "error",
									error: String(error.message || error),
									kind: "parse"
								});
							}
						})
						.catch((error) => {
							if (!disposed) {
								setGraphState({
									...EMPTY_GRAPH,
									phase: "error",
									error: String(error.message || error)
								});
							}
						});
				} catch (error) {
					setGraphState({
						...EMPTY_GRAPH,
						phase: "error",
						error: String(error.message || error)
					});
				}
				return () => {
					disposed = true;
					if (controller !== null) controller.abort();
				};
			}, [workspaceFiles, projectId, readSessionId, filePath, reloadKey]);

			if (selectedProject === undefined) {
				return h("div", { className: "dsm-root dsm-picker-root" },
					h(ProjectPicker, { workspaces, onSelect: selectProject, tr })
				);
			}

			let sourceText = "";
			let sourceError = false;
			if (graphState.phase === "loading") sourceText = tr("page.graphLoading");
			else if (graphState.phase === "ready") {
				sourceText = tr("page.graphReadyPrefix") + " · " +
					countText(tr, graphTasks.length, "page.countSessionsOne", "page.countSessionsMany") + " · " +
					countText(tr, dependencyEdgeCount, "page.countDependenciesOne", "page.countDependenciesMany");
			}
			else if (graphState.phase === "missing") sourceText = tr("page.graphMissing");
			else if (graphState.phase === "error") {
				sourceError = true;
				sourceText = graphState.kind === "parse"
					? tr("page.graphParseError", { message: graphState.error })
					: tr("page.graphError", { message: graphState.error });
			}

			const subParts = [
				countText(tr, rows.length, "page.countSessionsOne", "page.countSessionsMany"),
				countText(tr, dimensions.length, "page.countMainlinesOne", "page.countMainlinesMany"),
				countText(tr, linkedPrNumbers.size, "page.countLinkedPrsOne", "page.countLinkedPrsMany")
			];
			if (projectArchivedCount > 0) {
				subParts.push(countText(tr, projectArchivedCount, "page.countArchivedOne", "page.countArchivedMany"));
			}
			const subText = subParts.join(" · ");
			const header = h("header", { key: "head", className: "dsm-head" }, [
				h("div", { key: "titles" }, [
					h("h1", { key: "title", className: "dsm-title" }, tr("page.title")),
					h("p", { key: "sub", className: "dsm-sub" }, subText)
				]),
				h("span", {
					key: "source",
					className: "dsm-source" + (sourceError ? " is-error" : ""),
					title: sourceText
				}, sourceText)
			]);

			const projectSelect = h("select", {
				key: "project",
				className: "dsm-project-select",
				value: projectId,
				"aria-label": tr("page.pickProject"),
				onChange: (event) => selectProject(event.target.value)
			}, [
				h("option", { key: "switch", value: "" }, tr("page.switchProject")),
				...projectItems.map((item) => h("option", {
					key: item.workspaceId,
					value: item.workspaceId
				}, item.title || item.path))
			]);

			const viewButton = (name, label) => h("button", {
				key: name,
				type: "button",
				className: view === name ? "on" : "",
				"aria-pressed": view === name,
				onClick: () => setView(name)
			}, label);

			const commandLabel = (action, key) => summaryBusy && summaryAction === action
				? tr("page.generating")
				: tr(key);

			const toolbar = h("div", { key: "toolbar", className: "dsm-toolbar" }, [
				projectSelect,
				h("button", {
					key: "refresh",
					type: "button",
					className: "dsm-btn",
					disabled: graphState.phase === "loading",
					onClick: () => setReloadKey((value) => value + 1)
				}, tr("page.refresh")),
				h("button", {
					key: "summary",
					type: "button",
					className: "dsm-btn primary",
					title: tr("page.summaryHint"),
					disabled: summaryBusy || !canSummarize,
					onClick: summarizeProject
				}, commandLabel("sessions", "page.generateSummaries")),
				h("button", {
					key: "prs",
					type: "button",
					className: "dsm-btn",
					title: tr("page.prHint"),
					disabled: summaryBusy || !canSummarize,
					onClick: refreshPullRequests
				}, commandLabel("prs", "page.refreshPrs")),
				summaryMessage !== "" ? h("span", {
					key: "summaryStatus",
					className: "dsm-summary-status",
					title: summaryMessage
				}, summaryMessage) : null,
				h("span", { key: "spacer", className: "dsm-spacer" }),
				h("input", {
					key: "search",
					className: "dsm-search",
					type: "search",
					value: query,
					placeholder: tr("page.searchPlaceholder"),
					onChange: (event) => setQuery(event.target.value)
				}),
				h("div", { key: "views", className: "dsm-seg" }, [
					viewButton("cards", tr("page.cards")),
					viewButton("graph", tr("page.graph")),
					viewButton("prs", tr("page.prs"))
				]),
				h("label", { key: "archived", className: "dsm-toggle" }, [
					h("input", {
						key: "checkbox",
						type: "checkbox",
						checked: showArchived,
						onChange: (event) => setShowArchived(event.target.checked)
					}),
					tr("page.showArchived")
				]),
				h("div", { key: "legend", className: "dsm-legend" }, [
					legendItem("running", tr("page.running")),
					legendItem("active", tr("page.active")),
					legendItem("archived", tr("page.archived"))
				])
			]);

			const cardsBody = h("div", { key: "cards", className: "dsm-body" }, [
				h(FacetRail, {
					key: "facets",
					dimensions,
					dimensionCounts,
					uncategorizedCount,
					selectedDimension: effectiveDimension,
					selectedTag: effectiveTag,
					tagCounts,
					total: graphTasks.length,
					tr,
					onGenerateTaxonomy: generateTaxonomy,
					taxonomyBusy: summaryBusy && summaryAction === "taxonomy",
					generateDisabled: summaryBusy || !canSummarize,
					onSelectDimension: (id) => {
						setSelectedDimension(id);
						setSelectedTag("");
					},
					onSelectTag: setSelectedTag
				}),
				h("section", { key: "list", className: "dsm-cards" }, [
					h("div", { key: "head", className: "dsm-cards-head" }, [
						h("span", { key: "count" }, countText(tr, filteredTasks.length, "page.countCardsOne", "page.countCardsMany")),
						activeDimension === undefined
							? null
							: h("span", { key: "dim", className: "dsm-filter-note" },
								tr("page.currentDimension", { name: activeDimension.name }))
					]),
					filteredTasks.length === 0
						? h("div", { key: "empty", className: "dsm-empty" }, tr("page.noMatches"))
						: h("div", { key: "grid", className: "dsm-card-grid" }, filteredTasks.map((task) => h(SessionCard, {
							key: task.session,
							task,
							row: list.byId[task.session],
							archived,
							isCurrent: task.session === currentSessionId,
							taxonomy,
							prByNumber,
							repo: graphState.repo,
							tr,
							onOpen: openSession,
							onMenu: setMenuSessionId
						})))
				])
			]);

			const graphCanvas = rows.length === 0 || filteredTasks.length === 0
				? h("div", { key: "empty", className: "dsm-graph-empty" }, tr("page.graphEmpty"))
				: h(GraphView, {
					key: "graph",
					tasks: filteredTasks,
					taxonomy,
					prByNumber,
					repo: graphState.repo,
					archived,
					currentSessionId,
					tr,
					onOpen: openSession,
					onMenu: setMenuSessionId
				});

			const prsBody = h(PrPanel, {
				key: "prs",
				pullRequests,
				tasks: graphTasks,
				repo: graphState.repo,
				tr,
				onOpenSession: openSession,
				onRefresh: refreshPullRequests,
				busy: summaryBusy
			});

			const body = view === "prs" ? prsBody : view === "graph" ? graphCanvas : cardsBody;
			const noteText = view === "prs" ? tr("page.prNote") : view === "graph" ? tr("page.graphNote") : tr("page.cardsNote");

			const menuRow = menuSessionId === null ? undefined : list.byId[menuSessionId];
			const menuTask = menuSessionId === null ? undefined : graphTasks.find((task) => task.session === menuSessionId);
			const menuTitle = menuTask !== undefined ? (menuTask.displayTitle || menuTask.title) : (menuRow === undefined ? menuSessionId : (menuRow.displayTitle || menuSessionId));
			const menuArchived = menuSessionId !== null && archived.has(menuSessionId);
			const dialog = menuSessionId === null ? null : h("div", {
				className: "dsm-dialog-backdrop",
				onClick: () => setMenuSessionId(null)
			}, h("div", {
				className: "dsm-dialog",
				role: "dialog",
				"aria-modal": true,
				"aria-label": menuTitle,
				onClick: (event) => event.stopPropagation()
			}, [
				h("h3", { key: "title" }, menuTitle),
				h("p", { key: "id" }, shortId(menuSessionId)),
				h("button", {
					key: "open",
					type: "button",
					disabled: menuArchived,
					onClick: () => {
						setMenuSessionId(null);
						openSessionSafe(openSession, menuSessionId, menuArchived);
					}
				}, tr("page.openSession")),
				h("button", {
					key: "summary",
					type: "button",
					className: "primary",
					disabled: summaryBusy,
					onClick: () => summarizeOne(menuSessionId)
				}, tr("page.summarizeOne")),
				h("button", {
					key: "cancel",
					type: "button",
					onClick: () => setMenuSessionId(null)
				}, tr("page.cancel"))
			]));

			return h("div", { className: "dsm-root" }, [
				header,
				toolbar,
				body,
				h("p", { key: "note", className: "dsm-note" }, noteText),
				dialog
			]);
		}

		function FacetRail({
			dimensions,
			dimensionCounts,
			uncategorizedCount,
			selectedDimension,
			selectedTag,
			tagCounts,
			total,
			tr,
			onGenerateTaxonomy,
			taxonomyBusy,
			generateDisabled,
			onSelectDimension,
			onSelectTag
		}) {
			const active = dimensions.find((dimension) => dimension.id === selectedDimension);
			const facet = (key, label, count, color, isActive, onClick) => h("button", {
				key,
				type: "button",
				className: "dsm-facet" + (isActive ? " is-active" : ""),
				onClick
			}, [
				h("span", { key: "dot", className: "dsm-facet-dot", style: { background: color } }),
				h("span", { key: "name", className: "dsm-facet-name" }, label),
				h("span", { key: "count", className: "dsm-facet-count" }, String(count))
			]);
			return h("aside", { className: "dsm-facets" }, [
				h("div", { key: "scroll", className: "dsm-facets-scroll" }, [
					h("div", { key: "title", className: "dsm-facets-title" }, tr("page.dimensions")),
					facet("__all__", tr("page.allSessions"), total, "#6b8afd", selectedDimension === "", () => onSelectDimension("")),
				...dimensions.map((dimension, index) => facet(
					dimension.id,
					dimension.name,
					dimensionCounts.get(dimension.id) || 0,
					dimensionColor(index),
					selectedDimension === dimension.id,
					() => onSelectDimension(dimension.id)
				)),
				uncategorizedCount > 0
					? facet("__none__", tr("page.uncategorized"), uncategorizedCount, "#adb5bd", selectedDimension === "__none__", () => onSelectDimension("__none__"))
					: null,
				active === undefined ? null : h("div", { key: "tags", className: "dsm-tag-filter" }, [
					h("div", { key: "title", className: "dsm-tag-title" }, tr("page.tags")),
					h("button", {
						key: "__all__",
						type: "button",
						className: "dsm-tag" + (selectedTag === "" ? " is-active" : ""),
						onClick: () => onSelectTag("")
					}, tr("page.allTags")),
					...active.tags.map((tag) => h("button", {
						key: tag.id,
						type: "button",
						className: "dsm-tag" + (selectedTag === tag.id ? " is-active" : ""),
						onClick: () => onSelectTag(tag.id)
					}, `${tag.name} ${tagCounts.get(tag.id) || 0}`))
				]),
					dimensions.length === 0
						? h("p", { key: "hint", className: "dsm-facet-hint" }, tr("page.taxonomyMissing"))
						: null
				]),
				h("div", { key: "foot", className: "dsm-facets-foot" }, h("button", {
					key: "generate",
					type: "button",
					className: "dsm-facet-action",
					title: tr("page.taxonomyHint"),
					disabled: generateDisabled === true,
					onClick: () => {
						if (typeof onGenerateTaxonomy === "function") onGenerateTaxonomy();
					}
				}, taxonomyBusy ? tr("page.generating") : tr("page.generateTaxonomy")))
			]);
		}

		function SessionCard({ task, row, archived, isCurrent, taxonomy, prByNumber, repo, tr, onOpen, onMenu }) {
			const isArchived = archived.has(task.session);
			const known = row !== undefined;
			const clickable = known && !isArchived;
			const status = isArchived ? "archived" : row !== undefined && row.running ? "running" : "active";
			const statusLabel = tr("page." + status);
			const displayTitle = task.displayTitle || task.title;
			const assigned = (taxonomy === undefined ? [] : taxonomy.dimensions || []).map((dimension, index) => {
				const ids = (task.dimensions || {})[dimension.id] || [];
				const tags = dimension.tags.filter((tag) => ids.includes(tag.id));
				return { dimension, index, tags };
			}).filter((item) => item.tags.length > 0);
			const accent = STATUS_COLORS[status] || STATUS_COLORS.archived;
			const prs = (task.pullRequests || []).map((number) => {
				const pr = prByNumber.get(number);
				return pr === undefined
					? { number, title: "", url: pullRequestUrl(repo, number), state: "UNKNOWN" }
					: pr;
			});
			const dependencyText = (task.dependsOn || []).length > 0
				? task.dependsOn.map((id) => shortId(id)).join(", ")
				: "";
			const tooltip = [task.summary, dependencyText === "" ? "" : countText(tr, task.dependsOn.length, "page.countDependenciesOne", "page.countDependenciesMany") + ": " + dependencyText]
				.filter((part) => part !== "")
				.join("\n");

			const stop = (event) => {
				event.stopPropagation();
			};

			return h("article", {
				className: "dsm-card" +
					(isCurrent ? " is-current" : "") +
					(isArchived ? " is-archived" : "") +
					(!known ? " is-unknown" : ""),
				style: { "--dsm-accent": accent, "--dsm-bg": CARD_TINTS[status] || "#fff" },
				role: "button",
				tabIndex: clickable ? 0 : -1,
				"aria-disabled": !clickable,
				"aria-label": `${displayTitle}, ${statusLabel}`,
				title: tooltip || displayTitle,
				onClick: () => {
					if (clickable) openSessionSafe(onOpen, task.session, false);
				},
				onKeyDown: (event) => {
					if (clickable && (event.key === "Enter" || event.key === " ")) {
						event.preventDefault();
						openSessionSafe(onOpen, task.session, false);
					}
				},
				onContextMenu: (event) => {
					event.preventDefault();
					event.stopPropagation();
					if (typeof onMenu === "function") onMenu(task.session);
				}
			}, [
				h("div", { key: "head", className: "dsm-card-head" }, [
					h("span", { key: "dot", className: `dsm-dot ${status}` }),
					h("h3", { key: "title", className: "dsm-card-title" }, displayTitle),
					isCurrent ? h("span", { key: "current", className: "dsm-card-badge" }, tr("page.current")) : null,
					typeof onMenu === "function" ? h("button", {
						key: "menu",
						type: "button",
						className: "dsm-card-menu",
						"aria-label": tr("page.more"),
						onClick: (event) => {
							stop(event);
							onMenu(task.session);
						}
					}, "⋯") : null
				]),
				h("p", { key: "summary", className: "dsm-card-summary" + (task.summary === "" ? " is-empty" : "") },
					task.summary === "" ? tr("page.noSummary") : task.summary),
				assigned.length > 0
					? h("div", { key: "dims", className: "dsm-card-dims" }, assigned.map(({ dimension, index, tags }) => h("div", {
						key: dimension.id,
						className: "dsm-card-dim"
					}, [
						h("span", {
							key: "dot",
							className: "dsm-card-dim-dot",
							style: { background: dimensionColor(index) }
						}),
						h("span", { key: "name", className: "dsm-card-dim-name" }, dimension.name),
						...tags.map((tag) => h("span", { key: tag.id, className: "dsm-chip" }, tag.name))
					])))
					: h("div", { key: "dims", className: "dsm-card-dims is-empty" }, tr("page.uncategorized")),
				prs.length > 0
					? h("div", { key: "prs", className: "dsm-card-prs" }, prs.slice(0, 4).map((pr) => h("a", {
						key: pr.number,
						className: `dsm-pr-chip ${prStateClass(pr.state)}`,
						href: pr.url || pullRequestUrl(repo, pr.number),
						target: "_blank",
						rel: "noreferrer",
						title: pr.title || tr("page.openPr", { number: pr.number }),
						onClick: stop
					}, `#${pr.number}`)))
					: null,
				h("div", { key: "foot", className: "dsm-card-foot" }, [
					h("span", { key: "id" }, shortId(task.session)),
					h("span", { key: "status" }, statusLabel),
					row !== undefined && row.parentId !== undefined ? h("span", { key: "fork" }, tr("page.fork")) : null,
					task.dependsOn.length > 0 ? h("span", { key: "depends" }, countText(tr, task.dependsOn.length, "page.countDependenciesOne", "page.countDependenciesMany")) : null,
					row !== undefined && row.updatedAt !== undefined
						? h("span", { key: "time", className: "dsm-card-time" }, relativeTime(row.updatedAt, tr))
						: null
				])
			]);
		}

		function PrPanel({ pullRequests, tasks, repo, tr, onOpenSession, onRefresh, busy }) {
			const [scope, setScope] = React.useState("linked");
			const [stateFilter, setStateFilter] = React.useState("ALL");
			const [query, setQuery] = React.useState("");
			const linkedNumbers = new Set();
			const sessionsByPr = new Map();
			for (const task of tasks) {
				for (const number of task.pullRequests) {
					linkedNumbers.add(number);
					if (!sessionsByPr.has(number)) sessionsByPr.set(number, []);
					sessionsByPr.get(number).push(task);
				}
			}
			const linkedPullRequests = pullRequests.filter((pr) => linkedNumbers.has(pr.number));
			const scopedPullRequests = scope === "all" ? pullRequests : linkedPullRequests;
			const counts = { OPEN: 0, MERGED: 0, CLOSED: 0, UNKNOWN: 0 };
			for (const pr of scopedPullRequests) {
				const state = pr.state in counts ? pr.state : "UNKNOWN";
				counts[state] += 1;
			}
			const normalizedQuery = query.trim().toLowerCase();
			const filtered = scopedPullRequests.filter((pr) => {
				if (stateFilter !== "ALL" && pr.state !== stateFilter) return false;
				if (normalizedQuery === "") return true;
				return `${pr.number} ${pr.title} ${pr.author}`.toLowerCase().includes(normalizedQuery);
			}).sort((left, right) => prStateRank(left.state) - prStateRank(right.state) || right.number - left.number);
			const filterButton = (state, label) => h("button", {
				key: state,
				type: "button",
				className: "dsm-pr-filter" + (stateFilter === state ? " is-active" : ""),
				onClick: () => setStateFilter(state)
			}, `${label} ${state === "ALL" ? scopedPullRequests.length : counts[state]}`);
			const scopeButton = (value, label, count) => h("button", {
				key: value,
				type: "button",
				className: scope === value ? "on" : "",
				"aria-pressed": scope === value,
				onClick: () => {
					setScope(value);
					setStateFilter("ALL");
				}
			}, `${label} ${count}`);
			const emptyBox = (title, hint, action) => h("div", { key: "empty", className: "dsm-pr-empty" }, [
				h("div", { key: "box" }, [
					h("h3", { key: "title" }, title),
					h("p", { key: "hint" }, hint),
					action
				])
			]);
			const refreshButton = h("button", {
				key: "refresh",
				type: "button",
				className: "dsm-btn primary",
				disabled: busy,
				onClick: onRefresh
			}, busy ? tr("page.generating") : tr("page.refreshPrs"));
			let content;
			if (pullRequests.length === 0) {
				content = emptyBox(tr("page.prEmpty"), tr("page.prEmptyHint"), refreshButton);
			} else if (scopedPullRequests.length === 0) {
				content = emptyBox(
					tr("page.prLinkedEmpty"),
					tr("page.prLinkedEmptyHint"),
					h("button", {
						key: "all",
						type: "button",
						className: "dsm-btn primary",
						onClick: () => setScope("all")
					}, tr("page.prShowAll"))
				);
			} else if (filtered.length === 0) {
				content = emptyBox(
					tr("page.prNoMatches"),
					tr("page.prNoMatchesHint"),
					h("button", {
						key: "reset",
						type: "button",
						className: "dsm-btn",
						onClick: () => {
							setStateFilter("ALL");
							setQuery("");
						}
					}, tr("page.prAll"))
				);
			} else {
				content = h("div", { key: "list", className: "dsm-pr-list" }, filtered.map((pr) => {
					const related = sessionsByPr.get(pr.number) || [];
					const url = pr.url || pullRequestUrl(repo, pr.number);
					return h("article", { key: pr.number, className: "dsm-pr-row" }, [
						h("span", { key: "state", className: `dsm-pr-state ${prStateClass(pr.state)}` }, prStateLabel(pr.state, tr)),
						h("div", { key: "main", className: "dsm-pr-main" }, [
							h("a", {
								key: "title",
								className: "dsm-pr-title",
								href: url,
								target: "_blank",
								rel: "noreferrer",
								title: url
							}, `#${pr.number} ${pr.title || tr("page.untitled")}`),
							h("div", { key: "meta", className: "dsm-pr-meta" }, [
								pr.author || tr("page.noAuthor"),
								pr.updatedAt ? ` · ${tr("page.updatedAt", { time: relativeTime(pr.updatedAt, tr) })}` : "",
								related.length > 0 ? ` · ${countText(tr, related.length, "page.countPrSessionsOne", "page.countPrSessionsMany")}` : ""
							].join(""))
						]),
						h("div", { key: "sessions", className: "dsm-pr-sessions" },
							related.length === 0
								? h("span", { key: "none", className: "dsm-pr-none" }, tr("page.prNoSessions"))
								: related.map((task) => h("button", {
									key: task.session,
									type: "button",
									className: "dsm-session-chip",
									title: task.summary || task.displayTitle || task.title,
									onClick: () => {
										if (typeof onOpenSession === "function") onOpenSession(task.session);
									}
								}, task.displayTitle || task.title))
						)
					]);
				}));
			}
			return h("section", { className: "dsm-pr-panel" }, [
				h("div", { key: "head", className: "dsm-pr-head" }, [
					h("div", { key: "titles" }, [
						h("h2", { key: "title" }, tr(scope === "all" ? "page.prTitle" : "page.prTitleLinked")),
						h("p", { key: "sub", className: "dsm-pr-sub" }, [
							scope === "all"
								? countText(tr, scopedPullRequests.length, "page.countPrsOne", "page.countPrsMany")
								: countText(tr, scopedPullRequests.length, "page.countLinkedPrsOne", "page.countLinkedPrsMany"),
							countText(tr, counts.OPEN, "page.countOpenOne", "page.countOpenMany"),
							countText(tr, counts.MERGED, "page.countMergedOne", "page.countMergedMany")
						].join(" · "))
					]),
					h("div", { key: "scope", className: "dsm-pr-scope", title: tr("page.prScopeHint") },
						h("div", { className: "dsm-seg" }, [
							scopeButton("linked", tr("page.prScopeLinked"), linkedPullRequests.length),
							scopeButton("all", tr("page.prScopeAll"), pullRequests.length)
						]))
				]),
				h("div", { key: "filters", className: "dsm-pr-filters" }, [
					filterButton("ALL", tr("page.prAll")),
					filterButton("OPEN", tr("page.prOpen")),
					filterButton("MERGED", tr("page.prMerged")),
					filterButton("CLOSED", tr("page.prClosed")),
					h("span", { key: "spacer", className: "dsm-spacer" }),
					h("input", {
						key: "search",
						className: "dsm-search",
						type: "search",
						value: query,
						placeholder: tr("page.prSearch"),
						onChange: (event) => setQuery(event.target.value)
					})
				]),
				content
			]);
		}

		const GRAPH_KIND_ORDER = { tag: 0, pr: 1, session: 2 };

		function hashString(value) {
			let hash = 2166136261;
			const text = String(value || "");
			for (let index = 0; index < text.length; index++) {
				hash ^= text.charCodeAt(index);
				hash = Math.imul(hash, 16777619);
			}
			return hash >>> 0;
		}

		function countDependencyEdges(tasks) {
			const ids = new Set(tasks.map((task) => task.session));
			const edges = new Set();
			for (const task of tasks) {
				for (const dependency of task.dependsOn || []) {
					if (ids.has(dependency) && dependency !== task.session) edges.add(dependency + "->" + task.session);
				}
			}
			return edges.size;
		}

		/**
		 * Build the knowledge graph model.
		 *
		 * Obsidian's graph is not a tree: notes are nodes, wiki-links are edges,
		 * tags can be nodes too, and the layout is force-directed. We map the
		 * project data the same way:
		 *   session -> session  dependency edge
		 *   session -> tag      tag membership edge (rendered as `#tag`)
		 *   session -> PR       linked-PR edge
		 * Dimensions act as colour groups (like Obsidian colour groups), not as
		 * extra hub nodes, so the graph never collapses into a mind map.
		 */
		function buildKnowledgeGraph(tasks, taxonomy, prByNumber, options) {
			const settings = options === undefined || options === null ? {} : options;
			const dimensions = taxonomy !== undefined && Array.isArray(taxonomy.dimensions) ? taxonomy.dimensions : [];
			const nodes = [];
			const nodesById = new Map();
			const links = [];
			const archived = settings.archived instanceof Set ? settings.archived : new Set();

			const addNode = (node) => {
				const existing = nodesById.get(node.id);
				if (existing !== undefined) return existing;
				const value = { degree: 0, ...node };
				nodesById.set(value.id, value);
				nodes.push(value);
				return value;
			};
			const addLink = (source, target, kind) => {
				if (source === target) return;
				if (!nodesById.has(source) || !nodesById.has(target)) return;
				const id = kind + "|" + source + "|" + target;
				if (links.some((link) => link.id === id)) return;
				links.push({ id, source, target, kind });
			};

			for (const task of tasks) {
				const assigned = [];
				dimensions.forEach((dimension, index) => {
					const ids = task.dimensions !== undefined && Array.isArray(task.dimensions[dimension.id]) ? task.dimensions[dimension.id] : [];
					const tagById = new Map((Array.isArray(dimension.tags) ? dimension.tags : []).map((tag) => [tag.id, tag]));
					const tags = ids.map((id) => tagById.get(id)).filter((tag) => tag !== undefined);
					if (tags.length > 0) assigned.push({ dimension, index, tags });
				});
				const primary = assigned[0];
				addNode({
					id: "session:" + task.session,
					kind: "session",
					session: task.session,
					label: task.title || task.displayTitle || task.session,
					title: task.title || "",
					summary: task.summary || "",
					status: task.status === "running" ? "running" : "active",
					archived: archived.has(task.session),
					color: primary === undefined ? GRAPH_NEUTRAL : dimensionColor(primary.index),
					dimensionId: primary === undefined ? "" : primary.dimension.id,
					dimensions: assigned,
					tooltip: [task.displayTitle || task.title, task.summary].filter((part) => part !== "" && part !== undefined).join("\n")
				});
			}

			for (const task of tasks) {
				for (const dependency of task.dependsOn || []) {
					addLink("session:" + dependency, "session:" + task.session, "dependency");
				}
			}

			if (settings.showTags !== false) {
				for (const task of tasks) {
					const sessionNode = nodesById.get("session:" + task.session);
					if (sessionNode === undefined) continue;
					for (const assignment of sessionNode.dimensions) {
						for (const tag of assignment.tags) {
							const id = "tag:" + assignment.dimension.id + ":" + tag.id;
							addNode({
								id,
								kind: "tag",
								label: "#" + tag.name,
								title: tag.name,
								color: dimensionColor(assignment.index),
								dimensionId: assignment.dimension.id,
								tooltip: "#" + tag.name + " · " + assignment.dimension.name
							});
							addLink(sessionNode.id, id, "tag");
						}
					}
				}
			}

			if (settings.showPrs !== false) {
				for (const task of tasks) {
					const sessionNode = nodesById.get("session:" + task.session);
					if (sessionNode === undefined) continue;
					for (const number of task.pullRequests || []) {
						const pr = prByNumber === undefined ? undefined : prByNumber.get(number);
						const state = pr === undefined ? "UNKNOWN" : String(pr.state || "UNKNOWN").toUpperCase();
						const id = "pr:" + number;
						addNode({
							id,
							kind: "pr",
							number,
							label: "#" + number,
							title: pr === undefined ? "" : pr.title,
							state,
							url: pr !== undefined && pr.url !== undefined && pr.url !== ""
								? pr.url
								: pullRequestUrl(settings.repo || "", number),
							color: GRAPH_PR_COLORS[state] || GRAPH_PR_COLORS.UNKNOWN,
							tooltip: "#" + number + (pr === undefined || pr.title === undefined ? "" : " " + pr.title)
						});
						addLink(sessionNode.id, id, "pr");
					}
				}
			}

			for (const link of links) {
				const source = nodesById.get(link.source);
				const target = nodesById.get(link.target);
				if (source !== undefined) source.degree += 1;
				if (target !== undefined) target.degree += 1;
			}

			let visibleNodes = nodes;
			let visibleLinks = links;
			if (settings.localDepth > 0 && settings.focusSession !== undefined) {
				const start = nodesById.get("session:" + settings.focusSession);
				if (start !== undefined) {
					const adjacency = new Map(nodes.map((node) => [node.id, []]));
					for (const link of links) {
						adjacency.get(link.source).push(link.target);
						adjacency.get(link.target).push(link.source);
					}
					const keep = new Set([start.id]);
					const queue = [[start.id, 0]];
					while (queue.length > 0) {
						const [id, depth] = queue.shift();
						if (depth >= settings.localDepth) continue;
						for (const neighbour of adjacency.get(id) || []) {
							if (keep.has(neighbour)) continue;
							keep.add(neighbour);
							queue.push([neighbour, depth + 1]);
						}
					}
					visibleNodes = nodes.filter((node) => keep.has(node.id));
					visibleLinks = links.filter((link) => keep.has(link.source) && keep.has(link.target));
				}
			}

			visibleNodes.sort((left, right) => GRAPH_KIND_ORDER[left.kind] - GRAPH_KIND_ORDER[right.kind]);
			for (const node of visibleNodes) node.r = graphNodeRadius(node);

			const stats = {
				sessions: visibleNodes.filter((node) => node.kind === "session").length,
				tags: visibleNodes.filter((node) => node.kind === "tag").length,
				prs: visibleNodes.filter((node) => node.kind === "pr").length,
				links: visibleLinks.length,
				dependencies: visibleLinks.filter((link) => link.kind === "dependency").length
			};
			return {
				nodes: visibleNodes,
				links: visibleLinks,
				stats,
				byId: new Map(visibleNodes.map((node) => [node.id, node]))
			};
		}

		function graphNodeRadius(node) {
			if (node.kind === "tag") return 3.2 + Math.min(2.4, Math.sqrt(node.degree) * 0.7);
			if (node.kind === "pr") return 4.4;
			return 5.4 + Math.min(7, Math.sqrt(node.degree) * 1.4);
		}

		function seedGraphPosition(node, model, width, height, cache) {
			const hash = hashString(node.id);
			const centerX = width / 2;
			const centerY = height / 2;
			if (node.kind !== "session" && cache !== undefined) {
				let sumX = 0;
				let sumY = 0;
				let count = 0;
				for (const link of model.links) {
					if (link.source !== node.id && link.target !== node.id) continue;
					const other = cache.get(link.source === node.id ? link.target : link.source);
					if (other !== undefined) {
						sumX += other.x;
						sumY += other.y;
						count += 1;
					}
				}
				if (count > 0) {
					const jitter = ((hash % 100) / 100 - 0.5) * 34;
					return { x: sumX / count + jitter, y: sumY / count + jitter };
				}
			}
			const base = node.dimensionId !== "" && node.dimensionId !== undefined
				? (hashString(node.dimensionId) % 360) / 180 * Math.PI
				: (hash % 360) / 180 * Math.PI;
			const angle = base + ((hash % 97) / 97 - 0.5) * 0.9;
			const radius = 55 + (hash % 130);
			return { x: centerX + Math.cos(angle) * radius, y: centerY + Math.sin(angle) * radius };
		}

		function clamp(value, min, max) {
			return Math.max(min, Math.min(max, value));
		}

		/** One force-simulation step: repulsion + link springs + centring + collision. */
		function tickGraph(sim, width, height, alpha) {
			const nodes = sim.nodes;
			const centerX = width / 2;
			const centerY = height / 2;
			const repulsion = 4200;
			for (let left = 0; left < nodes.length; left++) {
				const a = nodes[left];
				for (let right = left + 1; right < nodes.length; right++) {
					const b = nodes[right];
					let dx = b.x - a.x;
					let dy = b.y - a.y;
					let squared = dx * dx + dy * dy;
					if (squared < 4) {
						const angle = (hashString(a.id + b.id) / 4294967295) * Math.PI * 2;
						dx = Math.cos(angle) * 2;
						dy = Math.sin(angle) * 2;
						squared = 4;
					}
					const distance = Math.sqrt(squared);
					const ux = dx / distance;
					const uy = dy / distance;
					let push = repulsion / Math.max(squared, 160) * alpha;
					const minimum = a.r + b.r + 6;
					if (distance < minimum) push += (minimum - distance) * 0.14 * alpha;
					a.vx -= ux * push;
					a.vy -= uy * push;
					b.vx += ux * push;
					b.vy += uy * push;
				}
			}
			for (const link of sim.links) {
				const a = link.source;
				const b = link.target;
				const dx = b.x - a.x;
				const dy = b.y - a.y;
				const distance = Math.max(1, Math.hypot(dx, dy));
				const target = GRAPH_LINK_DISTANCE[link.kind] || 70;
				const strength = GRAPH_LINK_STRENGTH[link.kind] || 0.04;
				const force = (distance - target) * strength * alpha;
				const ux = dx / distance;
				const uy = dy / distance;
				a.vx += ux * force;
				a.vy += uy * force;
				b.vx -= ux * force;
				b.vy -= uy * force;
			}
			for (const node of nodes) {
				if (node.fixed) {
					node.x = node.fx;
					node.y = node.fy;
					node.vx = 0;
					node.vy = 0;
					continue;
				}
				node.vx += (centerX - node.x) * 0.0022 * alpha;
				node.vy += (centerY - node.y) * 0.0022 * alpha;
				node.vx *= 0.86;
				node.vy *= 0.86;
				node.x += node.vx;
				node.y += node.vy;
				const pad = 28;
				node.x = clamp(node.x, pad, Math.max(pad, width - pad));
				node.y = clamp(node.y, pad, Math.max(pad, height - pad));
			}
		}

		function GraphView({ tasks, taxonomy, prByNumber, repo, archived, currentSessionId, tr, onOpen, onMenu }) {
			const [showTags, setShowTags] = React.useState(true);
			const [showPrs, setShowPrs] = React.useState(true);
			const [showArrows, setShowArrows] = React.useState(false);
			const [focusMode, setFocusMode] = React.useState(false);
			const [hovered, setHovered] = React.useState("");
			const [size, setSize] = React.useState({ width: 960, height: 520 });
			const [layoutNonce, setLayoutNonce] = React.useState(0);

			const containerRef = React.useRef(null);
			const svgRef = React.useRef(null);
			const viewportRef = React.useRef(null);
			const positionsRef = React.useRef(new Map());
			const transformRef = React.useRef({ x: 0, y: 0, k: 1 });
			const actionsRef = React.useRef(null);
			const suppressClickRef = React.useRef(false);

			const dimensions = taxonomy !== undefined && Array.isArray(taxonomy.dimensions) ? taxonomy.dimensions : [];
			const canFocus = currentSessionId !== undefined && tasks.some((task) => task.session === currentSessionId);
			const focusActive = focusMode && canFocus;
			const model = buildKnowledgeGraph(tasks, taxonomy, prByNumber, {
				showTags,
				showPrs,
				archived,
				repo,
				localDepth: focusActive ? GRAPH_LOCAL_DEPTH : 0,
				focusSession: currentSessionId
			});
			const signature = model.nodes.map((node) => node.id).join("|") + "#" + model.links.map((link) => link.id).join("|");
			const dense = model.stats.sessions > 24;

			// Seed sessions first so tags and PRs start next to the session they
			// belong to; the force layout then only has to relax the result.
			for (const node of [...model.nodes].reverse()) {
				if (!positionsRef.current.has(node.id)) {
					positionsRef.current.set(node.id, seedGraphPosition(node, model, size.width, size.height, positionsRef.current));
				}
			}

			const neighbors = new Set();
			if (hovered !== "") {
				for (const link of model.links) {
					if (link.source === hovered) neighbors.add(link.target);
					if (link.target === hovered) neighbors.add(link.source);
				}
			}

			React.useEffect(() => {
				const element = containerRef.current;
				if (element === null || element === undefined) return undefined;
				const measure = () => {
					const width = Math.max(320, Math.round(element.clientWidth || 0));
					const height = Math.max(280, Math.round(element.clientHeight || 0));
					setSize((previous) => previous.width === width && previous.height === height ? previous : { width, height });
				};
				measure();
				if (typeof ResizeObserver === "undefined") {
					if (typeof window === "undefined") return undefined;
					window.addEventListener("resize", measure);
					return () => window.removeEventListener("resize", measure);
				}
				const observer = new ResizeObserver(measure);
				observer.observe(element);
				return () => observer.disconnect();
			}, []);

			React.useEffect(() => {
				const container = containerRef.current;
				const svg = svgRef.current;
				const viewport = viewportRef.current;
				if (container === null || container === undefined) return undefined;
				if (svg === null || svg === undefined || viewport === null || viewport === undefined) return undefined;
				if (typeof window === "undefined" || model.nodes.length === 0) return undefined;

				const width = Math.max(320, size.width);
				const height = Math.max(280, size.height);
				const cache = positionsRef.current;
				const nodeById = new Map();
				const simNodes = [];
				model.nodes.forEach((node, index) => {
					let position = cache.get(node.id);
					if (position === undefined || typeof position.x !== "number" || typeof position.y !== "number") {
						position = seedGraphPosition(node, model, width, height, cache);
					}
					const value = { ...node, x: position.x, y: position.y, vx: 0, vy: 0, fixed: false };
					cache.set(node.id, value);
					nodeById.set(node.id, value);
					value.index = index;
					simNodes.push(value);
				});
				const simLinks = [];
				model.links.forEach((link, index) => {
					const source = nodeById.get(link.source);
					const target = nodeById.get(link.target);
					if (source === undefined || target === undefined) return;
					simLinks.push({ ...link, index, source, target });
				});
				const sim = { nodes: simNodes, links: simLinks };

				const count = simNodes.length;
				const iterations = count > 260 ? 80 : count > 120 ? 140 : 220;
				for (let index = 0; index < iterations; index++) {
					tickGraph(sim, width, height, 0.35 + 0.65 * (1 - index / iterations));
				}

				const nodeElements = new Map();
				svg.querySelectorAll("[data-graph-node]").forEach((nodeElement) => {
					nodeElements.set(Number(nodeElement.getAttribute("data-graph-node")), nodeElement);
				});
				const linkElements = new Map();
				svg.querySelectorAll("[data-graph-link]").forEach((linkElement) => {
					linkElements.set(Number(linkElement.getAttribute("data-graph-link")), linkElement);
				});

				const applyPositions = () => {
					for (const node of simNodes) {
						const nodeElement = nodeElements.get(node.index);
						if (nodeElement !== undefined) {
							nodeElement.setAttribute("transform", "translate(" + node.x.toFixed(2) + "," + node.y.toFixed(2) + ")");
						}
					}
					for (const link of simLinks) {
						const linkElement = linkElements.get(link.index);
						if (linkElement === undefined) continue;
						linkElement.setAttribute("x1", link.source.x.toFixed(2));
						linkElement.setAttribute("y1", link.source.y.toFixed(2));
						linkElement.setAttribute("x2", link.target.x.toFixed(2));
						linkElement.setAttribute("y2", link.target.y.toFixed(2));
					}
				};

				const applyTransform = (next) => {
					transformRef.current = next;
					viewport.setAttribute("transform", "translate(" + next.x.toFixed(2) + "," + next.y.toFixed(2) + ") scale(" + next.k.toFixed(3) + ")");
					container.dataset.zoom = next.k < 0.55 ? "far" : next.k < 1.35 ? "mid" : "near";
				};

				const fitView = () => {
					let minX = Infinity;
					let minY = Infinity;
					let maxX = -Infinity;
					let maxY = -Infinity;
					for (const node of simNodes) {
						minX = Math.min(minX, node.x - node.r);
						minY = Math.min(minY, node.y - node.r);
						maxX = Math.max(maxX, node.x + node.r);
						maxY = Math.max(maxY, node.y + node.r);
					}
					const boundsWidth = Math.max(1, maxX - minX);
					const boundsHeight = Math.max(1, maxY - minY);
					const padding = 52;
					const k = clamp(Math.min((width - padding * 2) / boundsWidth, (height - padding * 2) / boundsHeight), 0.16, 1.5);
					applyTransform({
						x: width / 2 - (minX + maxX) / 2 * k,
						y: height / 2 - (minY + maxY) / 2 * k,
						k
					});
				};

				const zoomBy = (factor) => {
					const current = transformRef.current;
					const k = clamp(current.k * factor, 0.12, 5);
					const centerX = width / 2;
					const centerY = height / 2;
					applyTransform({
						x: centerX - ((centerX - current.x) / current.k) * k,
						y: centerY - ((centerY - current.y) / current.k) * k,
						k
					});
				};

				let frame = 0;
				let running = false;
				const stepAnimation = () => {
					running = false;
					tickGraph(sim, width, height, 0.55);
					tickGraph(sim, width, height, 0.35);
					applyPositions();
					let energy = 0;
					for (const node of simNodes) energy += Math.abs(node.vx) + Math.abs(node.vy);
					if (energy > 0.4) {
						running = true;
						frame = window.requestAnimationFrame(stepAnimation);
					}
				};
				const startAnimation = () => {
					if (running) return;
					running = true;
					frame = window.requestAnimationFrame(stepAnimation);
				};

				let pan = null;
				let drag = null;
				const pointerPosition = (event) => {
					const rect = svg.getBoundingClientRect();
					const current = transformRef.current;
					const pixelX = (event.clientX - rect.left) * (width / Math.max(1, rect.width));
					const pixelY = (event.clientY - rect.top) * (height / Math.max(1, rect.height));
					return { x: (pixelX - current.x) / current.k, y: (pixelY - current.y) / current.k };
				};

				const onPointerDown = (event) => {
					if (event.button !== 0 && event.pointerType === "mouse") return;
					suppressClickRef.current = false;
					const target = event.target;
					const nodeElement = target !== null && typeof target.closest === "function" ? target.closest("[data-graph-node]") : null;
					if (nodeElement !== null) {
						const node = simNodes[Number(nodeElement.getAttribute("data-graph-node"))];
						if (node === undefined) return;
						// Do not capture the pointer yet: capture retargets the click to
						// the <svg>, which would break the node's normal click handler.
						drag = { node, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false };
						return;
					}
					const current = transformRef.current;
					pan = {
						pointerId: event.pointerId,
						startX: event.clientX,
						startY: event.clientY,
						originX: current.x,
						originY: current.y
					};
					container.classList.add("is-panning");
					try {
						svg.setPointerCapture(event.pointerId);
					} catch {
						/* pointer capture is optional; panning still works inside the svg */
					}
					event.preventDefault();
				};

				const onPointerMove = (event) => {
					if (pan !== null && event.pointerId === pan.pointerId) {
						applyTransform({
							x: pan.originX + event.clientX - pan.startX,
							y: pan.originY + event.clientY - pan.startY,
							k: transformRef.current.k
						});
						return;
					}
					if (drag === null || event.pointerId !== drag.pointerId) return;
					if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 3) {
						drag.moved = true;
						if (typeof svg.setPointerCapture === "function" && !svg.hasPointerCapture(event.pointerId)) {
							try {
								svg.setPointerCapture(event.pointerId);
							} catch {
								/* capture can fail if the pointer ended early */
							}
						}
					}
					if (!drag.moved) return;
					const position = pointerPosition(event);
					drag.node.fixed = true;
					drag.node.fx = position.x;
					drag.node.fy = position.y;
					drag.node.x = position.x;
					drag.node.y = position.y;
					startAnimation();
				};

				const endPointer = (event) => {
					if (pan !== null && event.pointerId === pan.pointerId) {
						pan = null;
						container.classList.remove("is-panning");
					}
					if (drag !== null && event.pointerId === drag.pointerId) {
						if (drag.moved) {
							suppressClickRef.current = true;
							startAnimation();
						}
						drag = null;
					}
					if (typeof svg.hasPointerCapture === "function" && svg.hasPointerCapture(event.pointerId)) {
						svg.releasePointerCapture(event.pointerId);
					}
				};

				const onWheel = (event) => {
					event.preventDefault();
					const current = transformRef.current;
					const rect = svg.getBoundingClientRect();
					const pixelX = (event.clientX - rect.left) * (width / Math.max(1, rect.width));
					const pixelY = (event.clientY - rect.top) * (height / Math.max(1, rect.height));
					const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1);
					const k = clamp(current.k * Math.exp(-delta * 0.0015), 0.12, 5);
					applyTransform({
						x: pixelX - ((pixelX - current.x) / current.k) * k,
						y: pixelY - ((pixelY - current.y) / current.k) * k,
						k
					});
				};

				applyPositions();
				fitView();

				actionsRef.current = {
					fit: fitView,
					relayout: () => {
						positionsRef.current = new Map();
						setLayoutNonce((value) => value + 1);
					},
					zoomIn: () => zoomBy(1.3),
					zoomOut: () => zoomBy(1 / 1.3)
				};

				svg.addEventListener("pointerdown", onPointerDown);
				svg.addEventListener("pointermove", onPointerMove);
				svg.addEventListener("pointerup", endPointer);
				svg.addEventListener("pointercancel", endPointer);
				svg.addEventListener("wheel", onWheel, { passive: false });

				return () => {
					svg.removeEventListener("pointerdown", onPointerDown);
					svg.removeEventListener("pointermove", onPointerMove);
					svg.removeEventListener("pointerup", endPointer);
					svg.removeEventListener("pointercancel", endPointer);
					svg.removeEventListener("wheel", onWheel);
					if (running) window.cancelAnimationFrame(frame);
					container.classList.remove("is-panning");
					actionsRef.current = null;
				};
			}, [signature, size.width, size.height, layoutNonce]);

			const activateNode = (node) => {
				if (suppressClickRef.current) {
					suppressClickRef.current = false;
					return;
				}
				if (node.kind === "session") {
					openSessionSafe(onOpen, node.session, node.archived);
					return;
				}
				if (node.kind === "pr" && node.url !== "" && typeof window !== "undefined") {
					try {
						window.open(node.url, "_blank", "noopener,noreferrer");
					} catch {
						/* popup blocked: the PR view still lists it */
					}
				}
			};

			const linkElements = model.links.map((link, index) => {
				const source = positionsRef.current.get(link.source) || { x: size.width / 2, y: size.height / 2 };
				const target = positionsRef.current.get(link.target) || { x: size.width / 2, y: size.height / 2 };
				const active = hovered !== "" && (link.source === hovered || link.target === hovered);
				const dimmed = hovered !== "" && !active;
				return h("line", {
					key: link.id,
					"data-graph-link": index,
					className: "dsm-graph-link " + link.kind + (active ? " is-active" : "") + (dimmed ? " is-dimmed" : ""),
					x1: source.x,
					y1: source.y,
					x2: target.x,
					y2: target.y,
					markerEnd: showArrows && link.kind === "dependency" ? "url(#dsm-graph-arrow)" : undefined
				});
			});

			const nodeElements = model.nodes.map((node, index) => {
				const position = positionsRef.current.get(node.id) || { x: size.width / 2, y: size.height / 2 };
				const isHover = hovered === node.id;
				const isNeighbor = neighbors.has(node.id);
				const isCurrent = node.kind === "session" && node.session === currentSessionId;
				const isRunning = node.kind === "session" && node.status === "running";
				const className = [
					"dsm-graph-node",
					"kind-" + node.kind,
					node.archived ? "is-archived" : "",
					isCurrent ? "is-current" : "",
					node.kind === "session" && node.degree >= 4 ? "is-hub" : "",
					hovered !== "" && isHover ? "is-hover" : "",
					hovered !== "" && isNeighbor ? "is-neighbor" : "",
					hovered !== "" && !isHover && !isNeighbor ? "is-dimmed" : ""
				].filter((part) => part !== "").join(" ");
				const label = truncate(node.label, node.kind === "session" ? 22 : 14);
				// Alternate labels above and below sessions so dense clusters stay readable.
				const labelY = node.kind === "session" && index % 2 === 1 ? -node.r - 6 : node.r + 11;
				const statusLabel = node.archived ? tr("page.archived") : node.status === "running" ? tr("page.running") : tr("page.active");
				const ariaLabel = node.kind === "session"
					? node.label + ", " + statusLabel
					: node.kind === "tag"
						? tr("page.graphTags") + ": " + node.label
						: tr("page.graphPrs") + ": " + node.label;
				const interactive = node.kind === "session" || (node.kind === "pr" && node.url !== "");
				const disabled = node.kind === "session" && node.archived;
				return h("g", {
					key: node.id,
					"data-graph-node": index,
					className,
					transform: "translate(" + position.x + "," + position.y + ")",
					role: interactive ? "button" : "img",
					tabIndex: interactive && !disabled ? 0 : -1,
					"aria-disabled": disabled ? true : undefined,
					"aria-label": ariaLabel,
					onClick: interactive ? () => activateNode(node) : undefined,
					onKeyDown: interactive ? (event) => {
						if (event.key === "Enter" || event.key === " ") {
							event.preventDefault();
							activateNode(node);
						}
					} : undefined,
					onContextMenu: node.kind === "session" && onMenu !== undefined ? (event) => {
						event.preventDefault();
						event.stopPropagation();
						onMenu(node.session);
					} : undefined,
					onMouseEnter: () => setHovered(node.id),
					onMouseLeave: () => setHovered((current) => current === node.id ? "" : current),
					onFocus: () => setHovered(node.id),
					onBlur: () => setHovered((current) => current === node.id ? "" : current)
				}, [
					h("title", { key: "title" }, node.tooltip || node.label),
					h("circle", { key: "hit", r: Math.max(node.r + 4, 9), fill: "transparent", pointerEvents: "all" }),
					isCurrent ? h("circle", { key: "current", r: node.r + 4, className: "dsm-graph-ring" }) : null,
					isRunning ? h("circle", { key: "running", r: node.r + 3, className: "dsm-graph-run" }) : null,
					h("circle", { key: "dot", r: node.r, fill: node.color, className: "dsm-graph-dot" }),
					h("text", { key: "label", y: labelY, textAnchor: "middle", className: "dsm-graph-label" }, label)
				]);
			});

			const toolbar = h("div", { className: "dsm-graph-toolbar" }, [
				h("button", {
					key: "focus",
					type: "button",
					className: focusActive ? "on" : "",
					title: tr("page.graphFocusHint", { depth: GRAPH_LOCAL_DEPTH }),
					"aria-pressed": focusActive,
					disabled: !canFocus,
					onClick: () => setFocusMode((value) => !value)
				}, focusActive ? tr("page.graphFocusOn") : tr("page.graphFocus")),
				h("span", { key: "sep1", className: "dsm-graph-sep" }),
				h("button", {
					key: "tags",
					type: "button",
					className: showTags ? "on" : "",
					"aria-pressed": showTags,
					onClick: () => setShowTags((value) => !value)
				}, tr("page.graphTags")),
				h("button", {
					key: "prs",
					type: "button",
					className: showPrs ? "on" : "",
					"aria-pressed": showPrs,
					onClick: () => setShowPrs((value) => !value)
				}, tr("page.graphPrs")),
				h("button", {
					key: "arrows",
					type: "button",
					className: showArrows ? "on" : "",
					"aria-pressed": showArrows,
					onClick: () => setShowArrows((value) => !value)
				}, tr("page.graphArrows")),
				h("span", { key: "sep2", className: "dsm-graph-sep" }),
				h("button", {
					key: "zoomOut",
					type: "button",
					title: tr("page.graphZoomOut"),
					onClick: () => { if (actionsRef.current !== null) actionsRef.current.zoomOut(); }
				}, "−"),
				h("button", {
					key: "zoomIn",
					type: "button",
					title: tr("page.graphZoomIn"),
					onClick: () => { if (actionsRef.current !== null) actionsRef.current.zoomIn(); }
				}, "+"),
				h("button", {
					key: "fit",
					type: "button",
					onClick: () => { if (actionsRef.current !== null) actionsRef.current.fit(); }
				}, tr("page.graphFit")),
				h("button", {
					key: "relayout",
					type: "button",
					onClick: () => { if (actionsRef.current !== null) actionsRef.current.relayout(); }
				}, tr("page.graphRelayout"))
			]);

			const legend = h("div", { className: "dsm-graph-legend" }, [
				h("span", { key: "sessions" }, [
					h("i", { key: "dot", style: { background: "#c7d2fe" } }),
					tr("page.graphSessions")
				]),
				h("span", { key: "tags" }, [
					h("i", { key: "dot", className: "tag", style: { background: "#5c7cfa" } }),
					tr("page.graphTags")
				]),
				h("span", { key: "prs" }, [
					h("i", { key: "dot", className: "pr", style: { background: "#8b7bd8" } }),
					tr("page.graphPrs")
				]),
				...dimensions.slice(0, 8).map((dimension, index) => h("span", { key: "dimension-" + dimension.id }, [
					h("i", { key: "dot", style: { background: dimensionColor(index) } }),
					dimension.name
				]))
			]);

			return h("div", {
				className: "dsm-graph" + (hovered === "" ? "" : " is-hovering") + (focusActive ? " is-local" : "") + (dense ? " is-dense" : ""),
				ref: containerRef
			}, [
				h("svg", {
					key: "svg",
					ref: svgRef,
					viewBox: "0 0 " + size.width + " " + size.height,
					preserveAspectRatio: "xMidYMid meet",
					role: "img",
					"aria-label": tr("page.graph")
				}, [
					h("defs", { key: "defs" }, h("marker", {
						id: "dsm-graph-arrow",
						viewBox: "0 0 10 10",
						refX: 9,
						refY: 5,
						markerWidth: 5,
						markerHeight: 5,
						orient: "auto-start-reverse"
					}, h("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "#8c96a8" }))),
					h("g", { key: "viewport", ref: viewportRef }, [
						h("g", { key: "links" }, linkElements),
						h("g", { key: "nodes" }, nodeElements)
					])
				]),
				toolbar,
				legend
			]);
		}

		function parseSessionGraph(text) {
			const raw = String(text || "");
			const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
			const payload = fenced === null ? raw.trim() : fenced[1];
			let data;
			try {
				data = JSON.parse(payload);
			} catch (error) {
				throw new Error(`not valid JSON: ${error.message}`);
			}
			if (data === null || typeof data !== "object") throw new Error("not a JSON object");

			const taxonomy = normalizeTaxonomy(data.taxonomy);
			const pullRequests = normalizePullRequests(data.pullRequests);
			const repo = typeof data.repo === "string" ? data.repo : "";
			const entries = new Map();
			const addEntry = (session, title, summary, dependsOn, dimensions, prs) => {
				if (typeof session !== "string" || session === "") return;
				const existing = entries.get(session);
				const dependencies = Array.isArray(dependsOn)
					? dependsOn.filter((value) => typeof value === "string" && value !== "")
					: [];
				const assigned = normalizeSessionDimensions(dimensions);
				const numbers = Array.isArray(prs)
					? prs.map((value) => Number(value)).filter((value) => Number.isFinite(value))
					: [];
				if (existing === undefined) {
					entries.set(session, {
						session,
						title: typeof title === "string" ? title : "",
						summary: typeof summary === "string" ? summary : "",
						dependsOn: [...new Set(dependencies)],
						dimensions: assigned,
						pullRequests: [...new Set(numbers)]
					});
					return;
				}
				if (existing.title === "" && typeof title === "string") existing.title = title;
				if (existing.summary === "" && typeof summary === "string") existing.summary = summary;
				existing.dependsOn = [...new Set([...existing.dependsOn, ...dependencies])];
				for (const [dimensionId, tags] of Object.entries(assigned)) {
					existing.dimensions[dimensionId] = [...new Set([...(existing.dimensions[dimensionId] || []), ...tags])];
				}
				existing.pullRequests = [...new Set([...existing.pullRequests, ...numbers])];
			};

			if (Array.isArray(data.sessions)) {
				for (const item of data.sessions) {
					if (item === null || typeof item !== "object") continue;
					addEntry(item.session, item.title, item.summary, item.dependsOn, item.dimensions, item.pullRequests);
				}
			} else if (Array.isArray(data.tasks)) {
				// Backward compatibility: task id -> session id, then fold into a session graph.
				const taskById = new Map();
				for (const item of data.tasks) {
					if (item === null || typeof item !== "object") continue;
					if (typeof item.id !== "string" || item.id === "") continue;
					taskById.set(item.id, item);
				}
				for (const item of taskById.values()) {
					const dependencySessions = Array.isArray(item.dependsOn)
						? item.dependsOn.map((id) => taskById.get(id)).filter((task) => task !== undefined).map((task) => task.session)
						: [];
					addEntry(item.session, item.title, item.note, dependencySessions);
				}
			} else {
				throw new Error("missing sessions or tasks array");
			}

			return {
				title: typeof data.title === "string" && data.title !== "" ? data.title : "DSH_SESSION_GRAPH",
				taxonomy,
				pullRequests,
				repo,
				entries: [...entries.values()]
			};
		}

		function normalizeTaxonomy(raw) {
			if (raw === null || typeof raw !== "object" || !Array.isArray(raw.dimensions)) {
				return { dimensions: [] };
			}
			const dimensions = [];
			for (const item of raw.dimensions) {
				if (item === null || typeof item !== "object") continue;
				if (typeof item.id !== "string" || item.id === "") continue;
				const tags = [];
				for (const tag of Array.isArray(item.tags) ? item.tags : []) {
					if (typeof tag === "string" && tag !== "") {
						tags.push({ id: tag, name: tag });
					} else if (tag !== null && typeof tag === "object" && typeof tag.id === "string" && tag.id !== "") {
						tags.push({ id: tag.id, name: typeof tag.name === "string" && tag.name !== "" ? tag.name : tag.id });
					}
				}
				dimensions.push({
					id: item.id,
					name: typeof item.name === "string" && item.name !== "" ? item.name : item.id,
					description: typeof item.description === "string" ? item.description : "",
					tags
				});
			}
			return { dimensions };
		}

		function normalizePullRequests(raw) {
			if (!Array.isArray(raw)) return [];
			const pullRequests = [];
			const seen = new Set();
			for (const item of raw) {
				if (item === null || typeof item !== "object") continue;
				const number = Number(item.number);
				if (!Number.isFinite(number) || seen.has(number)) continue;
				seen.add(number);
				pullRequests.push({
					number,
					title: typeof item.title === "string" ? item.title : "",
					url: typeof item.url === "string" ? item.url : "",
					state: normalizePrState(item.state),
					author: typeof item.author === "string" ? item.author : "",
					headRefName: typeof item.headRefName === "string" ? item.headRefName : "",
					updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : "",
					isDraft: item.isDraft === true
				});
			}
			return pullRequests.sort((left, right) => right.number - left.number);
		}

		function normalizeSessionDimensions(raw) {
			const dimensions = {};
			if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return dimensions;
			for (const [dimensionId, value] of Object.entries(raw)) {
				if (dimensionId === "") continue;
				const values = Array.isArray(value) ? value : [value];
				const tags = values.filter((item) => typeof item === "string" && item !== "");
				if (tags.length > 0) dimensions[dimensionId] = [...new Set(tags)];
			}
			return dimensions;
		}

		function normalizePrState(state) {
			const value = String(state || "").toUpperCase();
			return value === "OPEN" || value === "MERGED" || value === "CLOSED" ? value : "UNKNOWN";
		}

		function prStateClass(state) {
			return normalizePrState(state).toLowerCase();
		}

		function prStateRank(state) {
			const value = normalizePrState(state);
			return value === "OPEN" ? 0 : value === "MERGED" ? 1 : value === "CLOSED" ? 2 : 3;
		}

		function prStateLabel(state, tr) {
			const value = normalizePrState(state);
			return tr("page.pr" + value.charAt(0) + value.slice(1).toLowerCase());
		}

		function pullRequestUrl(repo, number) {
			return repo === "" ? "" : `https://github.com/${repo}/pull/${number}`;
		}

		function dimensionColor(index) {
			return DIMENSION_COLORS[index % DIMENSION_COLORS.length];
		}

		function prPrefix(numbers) {
			if (!Array.isArray(numbers) || numbers.length === 0) return "";
			const shown = numbers.slice(0, 2).map((number) => `[#${number}]`).join("");
			return numbers.length > 2 ? shown + `[+${numbers.length - 2}]` : shown;
		}

		function displayTaskTitle(task) {
			const title = String(task.title || "");
			if (/^\[#\d+\]/.test(title)) return title;
			const prefix = prPrefix(task.pullRequests);
			return prefix === "" ? title : `${prefix} ${title}`;
		}

		/**
		 * Titles the summary run actually changed, limited to sessions the map
		 * already knew about. A missing baseline (graph not loaded yet) yields no
		 * targets, so a summary can never rename the whole project by accident.
		 */
		function changedSessionTitles(beforeEntries, afterEntries, byId) {
			const before = new Map();
			for (const entry of Array.isArray(beforeEntries) ? beforeEntries : []) {
				if (entry !== null && typeof entry === "object" && typeof entry.session === "string") {
					before.set(entry.session, displayTaskTitle(entry));
				}
			}
			const targets = [];
			if (before.size === 0) return targets;
			for (const entry of Array.isArray(afterEntries) ? afterEntries : []) {
				if (entry === null || typeof entry !== "object" || typeof entry.session !== "string") continue;
				if (!before.has(entry.session)) continue;
				const title = displayTaskTitle(entry);
				if (title.trim() === "" || before.get(entry.session) === title) continue;
				const row = byId === undefined || byId === null ? undefined : byId[entry.session];
				if (row === undefined || row === null) continue;
				if (row.displayTitle === title) continue;
				targets.push({ session: entry.session, title });
			}
			return targets;
		}

		/**
		 * Read the graph after a summary run and rename the sessions whose titles
		 * changed. `includeSession` also reconciles the one session a targeted
		 * `/summarize-session` was run for, even when its summary was up to date.
		 * Failures stay local: a broken rename never turns a successful summary
		 * into a failed command.
		 */
		async function syncSessionTitles({ beforeEntries, workspaceFiles, readSessionId, filePath, byId, renameSession, refreshSessions, includeSession }) {
			if (beforeEntries === undefined || typeof renameSession !== "function") return { synced: 0, failed: 0 };
			if (workspaceFiles === undefined || typeof workspaceFiles.read !== "function" ||
				filePath === "" || readSessionId === undefined) {
				return { synced: 0, failed: 0 };
			}
			let read;
			try {
				read = await workspaceFiles.read(readSessionId, filePath, { offset: 1, limit: 5000 });
			} catch (error) {
				console.warn("session-graph: cannot read the graph for title sync", error);
				return { synced: 0, failed: 0 };
			}
			if (read === undefined || !read.ok) return { synced: 0, failed: 0 };
			let parsed;
			try {
				parsed = parseSessionGraph(read.value.text);
			} catch (error) {
				console.warn("session-graph: cannot parse the graph for title sync", error);
				return { synced: 0, failed: 0 };
			}
			const targets = changedSessionTitles(beforeEntries, parsed.entries, byId);
			if (typeof includeSession === "string" && includeSession !== "") {
				const already = targets.some((target) => target.session === includeSession);
				const entry = parsed.entries.find((item) => item.session === includeSession);
				if (!already && entry !== undefined) {
					const title = displayTaskTitle(entry);
					const row = byId === undefined || byId === null ? undefined : byId[includeSession];
					if (title.trim() !== "" && row !== undefined && row !== null && row.displayTitle !== title) {
						targets.push({ session: includeSession, title });
					}
				}
			}
			let synced = 0;
			let failed = 0;
			for (const target of targets) {
				try {
					await renameSession(target.session, target.title);
					synced += 1;
				} catch (error) {
					failed += 1;
					console.warn("session-graph: failed to sync a session title", target.session, error);
				}
			}
			if (synced > 0 && typeof refreshSessions === "function") {
				try {
					await refreshSessions();
				} catch (error) {
					console.warn("session-graph: failed to refresh the session list after title sync", error);
				}
			}
			return { synced, failed };
		}

		function openSessionSafe(openSession, sessionId, disabled) {
			if (disabled) return;
			try {
				openSession(sessionId);
			} catch (error) {
				console.warn("session-graph: openSession failed", error);
			}
		}

		function legendItem(kind, label) {
			return h("span", { key: kind }, [
				h("i", { key: "dot", className: kind }),
				label
			]);
		}

		function inProject(row, project, root) {
			if (Array.isArray(project.sessionIds) && project.sessionIds.includes(row.id)) return true;
			return root !== "" && row.cwd !== undefined && (row.cwd === root || row.cwd.startsWith(root + "/"));
		}

		function countText(tr, count, oneKey, manyKey) {
			return tr(count === 1 ? oneKey : manyKey, { count });
		}

		function relativeTime(value, tr) {
			const ms = typeof value === "number" ? value : Date.parse(String(value || ""));
			if (!Number.isFinite(ms)) return "";
			const diff = Date.now() - ms;
			const text = typeof tr === "function" ? tr : null;
			if (diff < 60e3) return text === null ? "刚刚" : text("page.justNow");
			if (diff < 3600e3) {
				const count = Math.floor(diff / 60e3);
				return text === null ? count + " 分钟前" : text("page.minutesAgo", { count });
			}
			if (diff < 86400e3) {
				const count = Math.floor(diff / 3600e3);
				return text === null ? count + " 小时前" : text("page.hoursAgo", { count });
			}
			if (diff < 7 * 86400e3) {
				const count = Math.floor(diff / 86400e3);
				return text === null ? count + " 天前" : text("page.daysAgo", { count });
			}
			const date = new Date(ms);
			return `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, "0")}`;
		}

		function shortId(sessionId) {
			return String(sessionId).replace(/^session-/, "").slice(0, 8);
		}

		function truncate(value, max) {
			const text = String(value || "");
			return text.length > max ? text.slice(0, max - 1) + "…" : text;
		}

		exports.PANEL_ID = PANEL_ID;
		exports.__test = {
			parseSessionGraph,
			buildKnowledgeGraph,
			seedGraphPosition,
			tickGraph,
			GraphView,
			normalizeTaxonomy,
			normalizePullRequests,
			changedSessionTitles,
			syncSessionTitles,
			SessionCard,
			PrPanel,
			FacetRail,
			CSS,
			zh,
			en
		};
		exports.apply = apply;
		exports.inject = ["slots", "locale", "sessions", "workspaces", "uiWorkspace", "remote", "remote.session", "remote.workspaceFiles", "remote.commands"];
		return module.exports;
	}
});
