/**
 * Shared headless-Chrome screenshot helper for the README previews.
 *
 * The `--screenshot` CLI on macOS lays the page out in a viewport smaller than
 * `--window-size` and then scales/extends the bitmap, which makes exact-height
 * screenshots unreliable. This helper drives Chrome over CDP instead: create a
 * tab, override the device metrics to exactly `width x height`, navigate, and
 * capture that viewport. It works the same on macOS and Linux.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const CHROMES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser"
];

export function findChrome() {
  return CHROMES.find((candidate) => existsSync(candidate));
}

function waitForDevTools(child) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("timed out waiting for Chrome DevTools")), 20_000);
    const cleanup = () => {
      clearTimeout(timer);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
    };
    const onData = (chunk) => {
      buffer += chunk.toString();
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
      if (match === null) return;
      cleanup();
      resolve(match[1]);
    };
    const onExit = () => {
      cleanup();
      reject(new Error("Chrome exited before the DevTools endpoint was ready"));
    };
    child.stderr.on("data", onData);
    child.on("exit", onExit);
  });
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const pending = new Map();
    const waiters = new Map();
    let nextId = 1;
    socket.addEventListener("open", () => {
      resolve({
        send(method, params = {}, sessionId) {
          return new Promise((resolveCall, rejectCall) => {
            const id = nextId++;
            pending.set(id, { resolve: resolveCall, reject: rejectCall });
            socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
          });
        },
        waitFor(method) {
          return new Promise((resolveEvent) => {
            const list = waiters.get(method) || [];
            list.push(resolveEvent);
            waiters.set(method, list);
          });
        },
        close() {
          socket.close();
        }
      });
    });
    socket.addEventListener("error", () => reject(new Error("DevTools WebSocket failed")));
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const entry = pending.get(message.id);
        if (entry === undefined) return;
        pending.delete(message.id);
        if (message.error !== undefined) entry.reject(new Error(message.error.message));
        else entry.resolve(message.result);
        return;
      }
      const list = waiters.get(message.method);
      if (list !== undefined && list.length > 0) list.shift()(message.params);
    });
  });
}

export async function capture(browser, htmlPath, target, width, height) {
  const profile = mkdtempSync(join(tmpdir(), "dsh-preview-"));
  const child = spawn(browser, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-crash-reporter",
    "--disable-breakpad",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank"
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let client;
  try {
    const wsUrl = await waitForDevTools(child);
    client = await connect(wsUrl);
    const created = await client.send("Target.createTarget", { url: "about:blank" });
    const attached = await client.send("Target.attachToTarget", { targetId: created.targetId, flatten: true });
    const sessionId = attached.sessionId;
    await client.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false
    }, sessionId);
    await client.send("Page.enable", {}, sessionId);
    const loaded = client.waitFor("Page.loadEventFired");
    await client.send("Page.navigate", { url: pathToFileURL(htmlPath).href }, sessionId);
    await loaded;
    await new Promise((resolve) => setTimeout(resolve, 350));
    const screenshot = await client.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
      clip: { x: 0, y: 0, width, height, scale: 1 }
    }, sessionId);
    writeFileSync(target, Buffer.from(screenshot.data, "base64"));
    if (!existsSync(target)) throw new Error(`screenshot was not written: ${target}`);
  } finally {
    if (client !== undefined) {
      try {
        await client.send("Browser.close");
      } catch {
        /* the browser may already be gone */
      }
      client.close();
    }
    child.kill();
    await new Promise((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      console.warn(`warning: could not remove Chrome profile ${profile}: ${error.message}`);
    }
  }
}
