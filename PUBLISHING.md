# 发布清单

## 发布到 npm

```bash
npm login
npm test
npm pack --dry-run     # 确认 tarball 里只有 lib/、locale/、test/、README、LICENSE、preview*.png
npm publish --access public
```

- 包名：`dsh-session-graph`（npm 上未占用；`dsh-session-map`、`dsh-session-board`、`dsh-session-dashboard` 已被别人使用）；
- 首次发布新包可能需要 npm 的 2FA / 暂存审批；
- 想免交互发布，可以在 npm 上生成带 *Bypass two-factor authentication* 的 granular token
  （Read and write + All packages），通过 `NPM_TOKEN` 注入到 CI，不要把 token 写进仓库。

## 发布到 GitHub

仓库即源码，`git push` 即可。用户可以直接从 git 安装：

```bash
dsh plugin --profile web add github:<user>/dsh-session-graph
```

## 版本

- 语义化版本；`npm version patch|minor|major`；
- 0.5.1 起 `preview.png` 由 `npm run screenshots` 用 `screenshots/demo.json` 的假数据生成；
  0.6.0 起同一条命令还会生成 `preview-graph.png`，两张图都不要提交真实会话截图；
- 依赖 DSH 0.2.x 的会话缓存格式（`storages/session_projcache`），DSH 大版本升级后可能需要跟进。
