/**
 * Host-half test: load `lib/index.js` with a fake Cordis context and check the
 * `/summarize-*` command registrations. Nothing here spawns Python or calls a
 * model; the handlers are only inspected, not invoked.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
assert.equal(manifest.private, undefined, "the package must not be private to publish it");
assert.equal(manifest.exports?.["./client"], "./lib/client.js");
assert.equal(manifest.dsh?.bundle?.patch, "./cordis.patch.yml");
assert.ok(
  fs.existsSync(new URL("../lib/summarize_sessions.py", import.meta.url)),
  "the bundled summarizer script is missing"
);
assert.ok(
  (manifest.files || []).includes("lib"),
  "the published files must include lib/, which carries the summarizer script"
);

const { apply, inject } = await import("../lib/index.js");
assert.deepEqual(inject, ["commands"], "the host half needs the commands service");

const registered = [];
const effects = [];
const ctx = {
  effect(callback) {
    effects.push(callback);
    callback();
  },
  commands: {
    register(command) {
      registered.push(command);
      return () => {};
    }
  }
};

apply(ctx);

assert.equal(effects.length, 5, "four commands plus the background PR refresh register through ctx.effect");
assert.deepEqual(
  registered.map((command) => command.name),
  ["summarize-taxonomy", "summarize-prs", "summarize-project", "summarize-session"]
);
for (const command of registered) {
  assert.equal(typeof command.description, "string");
  assert.ok(command.description.length > 0);
  assert.equal(typeof command.handler, "function");
}
assert.deepEqual(registered[3].input, { hint: "[--force]" });

console.log("ok: host registers the summarize commands and ships the summarizer script");
