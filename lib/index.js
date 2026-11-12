/**
 * Host half of dsh-session-graph.
 *
 * The browser side lives in `./client` and is served through the `dsh.client`
 * manifest. This entry adds the `/summarize-*` commands, which shell out to the
 * bundled `summarize_sessions.py` to turn DSH session data into the project's
 * `DSH_SESSION_GRAPH.md`. Nothing here calls a model directly: the script owns
 * the model route and credentials so it can also be run by hand.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "summarize_sessions.py");
const PYTHON = process.env.DSH_SUMMARY_PYTHON || "python3";
const TIMEOUT_MS = 900_000;
const MAX_OUTPUT = 6_000;

export const inject = ["commands"];

function projectOf(agent, rawInput) {
  const requested = String(rawInput || "").trim();
  const cwd = agent && agent.session && agent.session.header ? agent.session.header.cwd : undefined;
  return resolve(requested || cwd || process.cwd());
}

function runScript(project, extra, signal) {
  return new Promise((resolvePromise) => {
    if (!existsSync(SCRIPT)) {
      resolvePromise({
        ok: false,
        text: `summarizer script is missing at ${SCRIPT}; reinstall dsh-session-graph`,
      });
      return;
    }
    const args = [SCRIPT, "--write", "--project", project, ...extra];
    const child = spawn(PYTHON, args, {
      cwd: project,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ ok: false, text: `summarizer timed out after ${TIMEOUT_MS / 1000}s` });
    }, TIMEOUT_MS);
    const abort = () => child.kill("SIGTERM");
    if (signal) signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => finish({
      ok: false,
      text: error && error.code === "ENOENT"
        ? `cannot run ${PYTHON}; install Python 3.10+ or set DSH_SUMMARY_PYTHON`
        : String(error.message || error),
    }));
    child.on("close", (code) => {
      if (signal) signal.removeEventListener("abort", abort);
      const output = (stdout + (stderr ? `\n${stderr}` : "")).trim();
      finish({
        ok: code === 0,
        text: output.slice(-MAX_OUTPUT) || (code === 0 ? "summarizer finished" : `summarizer exited with ${code}`),
      });
    });
  });
}

export function apply(ctx) {
  ctx.effect(() => ctx.commands.register({
    name: "summarize-taxonomy",
    description: "Generate the project content dimensions, tags and PR catalog",
    input: { hint: "[project path]" },
    async handler({ agent, rawInput, signal }) {
      const project = projectOf(agent, rawInput);
      const result = await runScript(project, [
        "--mode", "taxonomy",
        "--max-sessions", "40",
        "--refresh-taxonomy",
      ], signal);
      return { kind: result.ok ? "success" : "error", text: result.text };
    },
  }), "session-graph: taxonomy command");

  ctx.effect(() => ctx.commands.register({
    name: "summarize-prs",
    description: "Refresh the project PR catalog from GitHub",
    input: { hint: "[project path]" },
    async handler({ agent, rawInput, signal }) {
      const project = projectOf(agent, rawInput);
      const result = await runScript(project, ["--mode", "prs"], signal);
      return { kind: result.ok ? "success" : "error", text: result.text };
    },
  }), "session-graph: prs command");

  ctx.effect(() => ctx.commands.register({
    name: "summarize-project",
    description: "Summarize changed project sessions, assign dimension tags and infer dependencies",
    input: { hint: "[project path]" },
    async handler({ agent, rawInput, signal }) {
      const project = projectOf(agent, rawInput);
      const result = await runScript(project, [
        "--mode", "sessions",
        "--relations",
        "--max-sessions", "40",
      ], signal);
      return { kind: result.ok ? "success" : "error", text: result.text };
    },
  }), "session-graph: project command");

  ctx.effect(() => ctx.commands.register({
    name: "summarize-session",
    description: "Summarize and tag the current session",
    input: { hint: "[--force]" },
    async handler({ agent, rawInput, signal }) {
      const project = projectOf(agent, "");
      const extra = ["--mode", "sessions", "--session", agent.id];
      // Up-to-date sessions are skipped; `--force` redoes them.
      if (/(^|\s)--?force\b/i.test(String(rawInput || ""))) extra.push("--force");
      const result = await runScript(project, extra, signal);
      return { kind: result.ok ? "success" : "error", text: result.text };
    },
  }), "session-graph: session command");
}
