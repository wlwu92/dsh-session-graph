/**
 * DSH Web client plugin: a session map.
 *
 * Views:
 *   cards - session cards grouped by project dimensions and tags
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
		const CARD_TINTS = { running: "#f7fdf9", active: "#fafbff", archived: "#fbfbfc" };
		const AUTO_REFRESH_MS = 60_000;
		const PROGRESS_FILE_NAME = ".dsh-session-graph.progress.json";
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
			"page.sourceFile": "DSH_SESSION_GRAPH.md",
			"page.sourceLoading": "正在读取 DSH_SESSION_GRAPH.md…",
			"page.sourceMissing": "未找到 DSH_SESSION_GRAPH.md，只显示实时会话。",
			"page.sourceError": "读取 DSH_SESSION_GRAPH.md 失败：{message}",
			"page.sourceParseError": "DSH_SESSION_GRAPH.md 解析失败：{message}",
			"page.showArchived": "显示已归档",
			"page.running": "运行中",
			"page.active": "活跃",
			"page.archived": "已归档",
			"page.fork": "Fork",
			"page.current": "当前",
			"page.empty": "没有可显示的会话。",
			"page.noMatches": "没有匹配的会话。",
			"page.cards": "卡片",
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
			"page.generating": "生成中…",
			"page.taxonomyRunning": "正在生成项目维度、标签与 PR…",
			"page.summaryRunning": "正在生成会话摘要与标签…",
			"page.progressSummary": "正在生成摘要 {done}/{total} · {current}",
			"page.progressSummaryNoCurrent": "正在生成摘要 {done}/{total}",
			"page.progressTaxonomy": "正在生成项目维度…",
			"page.progressRelations": "正在整理会话依赖…",
			"page.progressWriting": "正在写入 DSH_SESSION_GRAPH.md…",
			"page.summaryDone": "已更新，正在刷新面板…",
			"page.summaryUnavailable": "摘要命令未安装；更新插件后重启 DSH 再试。",
			"page.summaryNoSession": "没有可用于执行命令的 session。",
			"page.summaryFailed": "执行失败：{message}",
			"page.summarySynced": "已同步 {count} 个 session 标题",
			"page.summarySyncFailed": "{count} 个标题同步失败",
			"page.taxonomyHint": "调用模型生成项目主线维度与标签，并从 GitHub 拉取 PR；可能产生费用",
			"page.summaryHint": "调用模型重写标题/摘要并分配维度标签，同时刷新 PR 目录；没更新的 session 会跳过，可能产生费用",
			"page.cardsNote": "点击卡片切换 session；先「生成维度」再「生成摘要」，卡片就会带主线标签和 PR。",
			"page.prNote": "PR 页默认只显示有 session 关联的 PR；可切换「全部项目 PR」。关联来自 turns 里的 PR URL、`PR #123` 文本或 head branch；GitHub 状态会自动刷新。",
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
			"page.prEmptyHint": "后台会每 1-2 分钟从 GitHub 刷新项目 PR；请确认仓库已配置 gh 登录。",
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
			"page.sourceFile": "DSH_SESSION_GRAPH.md",
			"page.sourceLoading": "Reading DSH_SESSION_GRAPH.md…",
			"page.sourceMissing": "DSH_SESSION_GRAPH.md not found; showing live sessions only.",
			"page.sourceError": "Failed to read DSH_SESSION_GRAPH.md: {message}",
			"page.sourceParseError": "Failed to parse DSH_SESSION_GRAPH.md: {message}",
			"page.showArchived": "Show archived",
			"page.running": "Running",
			"page.active": "Active",
			"page.archived": "Archived",
			"page.fork": "Fork",
			"page.current": "Current",
			"page.empty": "No sessions to show.",
			"page.noMatches": "No matching sessions.",
			"page.cards": "Cards",
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
			"page.generating": "Generating…",
			"page.taxonomyRunning": "Generating project dimensions, tags and PRs…",
			"page.summaryRunning": "Generating session summaries and tags…",
			"page.progressSummary": "Generating summaries {done}/{total} · {current}",
			"page.progressSummaryNoCurrent": "Generating summaries {done}/{total}",
			"page.progressTaxonomy": "Generating project dimensions…",
			"page.progressRelations": "Inferring session dependencies…",
			"page.progressWriting": "Writing DSH_SESSION_GRAPH.md…",
			"page.summaryDone": "Updated; reloading the panel…",
			"page.summaryUnavailable": "Summarizer command is unavailable. Update the plugin and restart DSH.",
			"page.summaryNoSession": "No session is available to run the command.",
			"page.summaryFailed": "Command failed: {message}",
			"page.summarySynced": "Synced {count} session title(s)",
			"page.summarySyncFailed": "{count} title sync(s) failed",
			"page.taxonomyHint": "Calls the model for project dimensions and tags, and fetches PRs from GitHub; may cost money",
			"page.summaryHint": "Calls the model to rewrite titles/summaries, assign tags and refresh the PR catalog; unchanged sessions are skipped and may cost money",
			"page.cardsNote": "Click a card to switch sessions. Generate dimensions first, then summaries, to fill in tags and PRs.",
			"page.prNote": "The PR view shows session-linked PRs by default; switch to “All project PRs” for the full catalog. Links come from PR URLs, `PR #123` text or head branches; GitHub state refreshes automatically.",
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
			"page.prEmptyHint": "The background refreshes project PRs from GitHub every 1-2 minutes; make sure gh is signed in.",
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
.dsm-summary-status { display: block; flex: none; width: 100%; box-sizing: border-box; margin: 0 0 10px; padding: 5px 9px; border-radius: 7px; background: var(--dsw-alias-bg-layer-2, #f7f8fa); color: var(--dsw-alias-label-secondary, #57606a); font-size: 11px; line-height: 1.45; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
			const progressRunRef = React.useRef(0);

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
			const progressPath = projectPath === "" ? "" : projectPath + "/" + PROGRESS_FILE_NAME;

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
				setSummaryMessage(action === "taxonomy" ? tr("page.taxonomyRunning") : tr("page.summaryRunning"));
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
				// A periodic background reload must not blank the cards while the
				// replacement read is in flight; only the very first load clears.
				setGraphState((previous) => previous.phase === "ready"
					? { ...previous, phase: "loading" }
					: { ...EMPTY_GRAPH, phase: "loading" });
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

			// The Host refreshes the PR catalog in the background; re-read the
			// graph file periodically so new PR states show up without a button.
			React.useEffect(() => {
				if (projectPath === "" || typeof window === "undefined" ||
					typeof window.setInterval !== "function") return undefined;
				const timer = window.setInterval(() => {
					if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
					setReloadKey((value) => value + 1);
				}, AUTO_REFRESH_MS);
				return () => window.clearInterval(timer);
			}, [projectPath]);

			// While a summary command runs, the script publishes its progress to a
			// small JSON file next to DSH_SESSION_GRAPH.md. Poll it so the status
			// line can show "done/total" instead of a static spinner message.
			React.useEffect(() => {
				if (!summaryBusy || progressPath === "" || readSessionId === undefined ||
					workspaceFiles === undefined || typeof workspaceFiles.read !== "function" ||
					typeof window === "undefined" || typeof window.setInterval !== "function") {
					return undefined;
				}
				let disposed = false;
				let reading = false;
				const runId = progressRunRef.current + 1;
				progressRunRef.current = runId;
				const tick = () => {
					if (disposed || reading) return;
					reading = true;
					workspaceFiles.read(readSessionId, progressPath, { offset: 1, limit: 100 })
						.then((result) => {
							if (disposed || progressRunRef.current !== runId) return;
							if (result === undefined || !result.ok) return;
							let progress;
							try {
								progress = JSON.parse(result.value.text);
							} catch {
								return;
							}
							const message = progressMessage(progress, tr);
							if (message !== "") {
								setSummaryMessage((previous) => previous === message ? previous : message);
							}
						})
						.catch(() => {
							/* the file may be removed as the command finishes */
						})
						.finally(() => {
							reading = false;
						});
				};
				tick();
				const timer = window.setInterval(tick, 1000);
				return () => {
					disposed = true;
					progressRunRef.current += 1;
					window.clearInterval(timer);
				};
			}, [summaryBusy, progressPath, readSessionId, workspaceFiles]);

			if (selectedProject === undefined) {
				return h("div", { className: "dsm-root dsm-picker-root" },
					h(ProjectPicker, { workspaces, onSelect: selectProject, tr })
				);
			}

			let sourceText = "";
			let sourceError = false;
			if (graphState.phase === "loading") sourceText = tr("page.sourceLoading");
			else if (graphState.phase === "ready") {
				sourceText = tr("page.sourceFile") + " · " +
					countText(tr, graphTasks.length, "page.countSessionsOne", "page.countSessionsMany");
			}
			else if (graphState.phase === "missing") sourceText = tr("page.sourceMissing");
			else if (graphState.phase === "error") {
				sourceError = true;
				sourceText = graphState.kind === "parse"
					? tr("page.sourceParseError", { message: graphState.error })
					: tr("page.sourceError", { message: graphState.error });
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

			const prsBody = h(PrPanel, {
				key: "prs",
				pullRequests,
				tasks: graphTasks,
				repo: graphState.repo,
				tr,
				onOpenSession: openSession
			});

			const body = view === "prs" ? prsBody : cardsBody;
			const noteText = view === "prs" ? tr("page.prNote") : tr("page.cardsNote");

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

			const summaryLine = summaryMessage === "" ? null : h("div", {
				key: "summaryStatus",
				className: "dsm-summary-status",
				title: summaryMessage,
				role: "status"
			}, summaryMessage);

			return h("div", { className: "dsm-root" }, [
				header,
				toolbar,
				summaryLine,
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

		function PrPanel({ pullRequests, tasks, repo, tr, onOpenSession }) {
			const [scope, setScope] = React.useState("linked");
			const [stateFilter, setStateFilter] = React.useState("ALL");
			const [query, setQuery] = React.useState("");
			const progressRunRef = React.useRef(0);
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
			let content;
			if (pullRequests.length === 0) {
				content = emptyBox(tr("page.prEmpty"), tr("page.prEmptyHint"), null);
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

		/** Turn the summarizer's progress file into one status-line message. */
		function progressMessage(progress, tr) {
			if (progress === null || typeof progress !== "object") return "";
			const phase = String(progress.phase || "");
			if (phase === "taxonomy") return tr("page.progressTaxonomy");
			if (phase === "relations") return tr("page.progressRelations");
			if (phase === "writing") return tr("page.progressWriting");
			if (phase !== "sessions") return "";
			const totalValue = Number(progress.total);
			const doneValue = Number(progress.completed);
			const total = Number.isFinite(totalValue) && totalValue > 0 ? Math.floor(totalValue) : 0;
			const done = Number.isFinite(doneValue) && doneValue > 0 ? Math.floor(doneValue) : 0;
			if (total === 0) return tr("page.summaryRunning");
			const current = String(progress.current || "").trim();
			if (current !== "") {
				return tr("page.progressSummary", { done: Math.min(done, total), total, current });
			}
			return tr("page.progressSummaryNoCurrent", { done: Math.min(done, total), total });
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

		exports.PANEL_ID = PANEL_ID;
		exports.__test = {
			parseSessionGraph,
			progressMessage,
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
