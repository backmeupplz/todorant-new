import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const candidates = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser"
].filter(Boolean);
const chrome = candidates.find((candidate) => existsSync(candidate));
if (!chrome) throw new Error("Chrome or Chromium is required for the Planning Add computed-style regression");

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
const connect = (url) => new Promise((resolveConnection, rejectConnection) => {
  const socket = new globalThis.WebSocket(url);
  const pending = new Map();
  let sequence = 0;
  socket.addEventListener("error", () => rejectConnection(new Error(`Could not connect to Chrome DevTools at ${url}`)), { once: true });
  socket.addEventListener("open", () => resolveConnection({
    close: () => socket.close(),
    send: (method, params = {}) => new Promise((resolveCommand, rejectCommand) => {
      const id = ++sequence;
      pending.set(id, { resolveCommand, rejectCommand });
      socket.send(JSON.stringify({ id, method, params }));
    })
  }), { once: true });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const command = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) command.rejectCommand(new Error(`${message.error.message} (${message.error.code})`));
    else command.resolveCommand(message.result);
  });
});

const channel = (value) => {
  const normalized = value / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
};
const luminance = (color) => {
  const channels = color.match(/[\d.]+/gu)?.slice(0, 3).map(Number);
  if (!channels || channels.length !== 3) throw new Error(`Cannot parse computed color: ${color}`);
  return (0.2126 * channel(channels[0])) + (0.7152 * channel(channels[1])) + (0.0722 * channel(channels[2]));
};
const contrast = (first, second) => {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
};

const fixture = resolve(import.meta.dirname, "add-context.fixture.html");
const stylesheet = resolve(import.meta.dirname, "../src/styles.css");
const server = createServer(async (request, response) => {
  if (request.url === "/src/styles.css") {
    response.writeHead(200, { "Content-Type": "text/css" });
    response.end(await readFile(stylesheet));
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end(await readFile(fixture));
});
const profile = await mkdtemp(join(tmpdir(), "todorant-add-contrast-"));
let browserConnection;
let chromeProcess;

try {
  await new Promise((resolveListening) => server.listen(0, "127.0.0.1", resolveListening));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not expose a local port");
  const url = `http://127.0.0.1:${address.port}/scripts/add-context.fixture.html`;

  chromeProcess = spawn(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-extensions",
    "--disable-sync",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank"
  ], { stdio: "ignore" });

  let activePort;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      activePort = await readFile(join(profile, "DevToolsActivePort"), "utf8");
      break;
    } catch {
      if (chromeProcess.exitCode !== null) throw new Error(`Chrome exited before DevTools was ready (${chromeProcess.exitCode})`);
      await delay(50);
    }
  }
  if (!activePort) throw new Error("Chrome DevTools did not become ready");
  const [port, browserPath] = activePort.trim().split("\n");
  browserConnection = await connect(`ws://127.0.0.1:${port}${browserPath}`);
  const target = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" }).then((response) => response.json());
  const page = await connect(target.webSocketDebuggerUrl);

  try {
    await page.send("Page.enable");
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.send("Page.navigate", { url });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const readiness = await page.send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
      if (readiness.result.value === "complete") break;
      await delay(50);
    }
    const evaluated = await page.send("Runtime.evaluate", {
      expression: "document.querySelector('#computed-styles')?.textContent",
      returnByValue: true
    });
    const snapshots = JSON.parse(evaluated.result.value);
    for (const snapshot of snapshots) {
      const ratio = contrast(snapshot.background, snapshot.foreground);
      if (snapshot.background === snapshot.surface) {
        throw new Error(`${snapshot.theme} Planning Add uses the secondary surface background ${snapshot.background}`);
      }
      if (snapshot.background !== snapshot.accent) {
        throw new Error(`${snapshot.theme} Planning Add background ${snapshot.background} does not match accent ${snapshot.accent}`);
      }
      if (ratio < 4.5) {
        throw new Error(`${snapshot.theme} Planning Add contrast ${ratio.toFixed(2)}:1 is below 4.5:1 (${snapshot.background} / ${snapshot.foreground})`);
      }
      console.log(`${snapshot.theme} Planning Add: ${snapshot.background} / ${snapshot.foreground} = ${ratio.toFixed(2)}:1`);
      for (const control of snapshot.controls) {
        const controlRatio = contrast(control.background, control.foreground);
        if (controlRatio < 4.5) {
          throw new Error(`${snapshot.theme} ${control.state} Planning control contrast ${controlRatio.toFixed(2)}:1 is below 4.5:1 (${control.background} / ${control.foreground})`);
        }
        if (Number.parseFloat(control.height) < 44 || Number.parseFloat(control.width) < 44) {
          throw new Error(`${snapshot.theme} ${control.state} Planning control is below the 44px target (${control.width} × ${control.height})`);
        }
        console.log(`${snapshot.theme} ${control.state} Planning control: ${control.width} × ${control.height}, ${controlRatio.toFixed(2)}:1`);
      }
    }
    const measureTaskRow = async (label, width, height, mobile) => {
      await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
      const measured = await page.send("Runtime.evaluate", {
        expression: "window.taskRowSnapshot()",
        returnByValue: true
      });
      const snapshot = measured.result.value;
      if (snapshot.actions.display !== "flex" || snapshot.buttons.length !== 4) {
        throw new Error(`${label} task actions are not always exposed (${snapshot.actions.display}, ${snapshot.buttons.length} buttons)`);
      }
      if (snapshot.row.scrollWidth > snapshot.row.clientWidth || snapshot.row.right > snapshot.viewportWidth) {
        throw new Error(`${label} task row overflows (${snapshot.row.scrollWidth}/${snapshot.row.clientWidth}, right ${snapshot.row.right}/${snapshot.viewportWidth})`);
      }
      if (snapshot.title.right > snapshot.actions.left || snapshot.title.overflow !== "ellipsis") {
        throw new Error(`${label} task title does not truncate before actions (${snapshot.title.right}/${snapshot.actions.left}, ${snapshot.title.overflow})`);
      }
      for (const action of snapshot.buttons) {
        if (action.display === "none" || action.width < 44 || action.height < 44 || !action.title || !action.label) {
          throw new Error(`${label} task action fails discoverability geometry: ${JSON.stringify(action)}`);
        }
      }
      console.log(`${label} task row: ${snapshot.row.width}px, title ${snapshot.title.width}px, ${snapshot.buttons.length} exposed 44px actions`);
    };
    await measureTaskRow("desktop", 1000, 900, false);
    await measureTaskRow("390×844 mobile", 390, 844, true);
  } finally {
    page.close();
  }
} finally {
  if (browserConnection) {
    await browserConnection.send("Browser.close").catch(() => undefined);
    browserConnection.close();
  }
  if (chromeProcess?.exitCode === null) {
    await new Promise((resolveExit) => chromeProcess.once("exit", resolveExit));
  }
  await new Promise((resolveClosed, rejectClosed) => server.close((error) => error ? rejectClosed(error) : resolveClosed()));
  await rm(profile, { recursive: true, force: true });
}
