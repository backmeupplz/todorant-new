import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer as createViteServer } from "vite";

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

const webRoot = resolve(import.meta.dirname, "..");
const profile = await mkdtemp(join(tmpdir(), "todorant-add-contrast-"));
let browserConnection;
let chromeProcess;
let viteServer;

try {
  viteServer = await createViteServer({ root: webRoot, logLevel: "error", server: { host: "127.0.0.1", port: 0 } });
  await viteServer.listen();
  const address = viteServer.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not expose a local port");
  const url = `http://127.0.0.1:${address.port}/scripts/add-context.fixture.html`;
  const taskActionsUrl = `http://127.0.0.1:${address.port}/task-actions.fixture.html`;

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
    const waitFor = async (expression) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const readiness = await page.send("Runtime.evaluate", { expression, returnByValue: true });
        if (readiness.result.value) return;
        await delay(50);
      }
      throw new Error(`Timed out waiting for fixture condition: ${expression}`);
    };
    await page.send("Page.navigate", { url });
    await waitFor("document.readyState === 'complete' && Boolean(document.querySelector('#computed-styles')?.textContent)");
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
      if (snapshot.background !== snapshot.actionAccent) {
        throw new Error(`${snapshot.theme} Planning Add background ${snapshot.background} does not match action accent ${snapshot.actionAccent}`);
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
    const measurePlanningLayout = async (label, width, height, mobile) => {
      await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
      const measured = await page.send("Runtime.evaluate", {
        expression: "window.planningLayoutSnapshot()",
        returnByValue: true
      });
      const snapshot = measured.result.value;
      const alignmentTolerance = 1;
      if (Math.abs(snapshot.topbarStart.left - snapshot.workspace.left) > alignmentTolerance ||
          Math.abs(snapshot.groups.left - snapshot.workspace.left) > alignmentTolerance ||
          Math.abs(snapshot.groups.right - snapshot.workspace.right) > alignmentTolerance) {
        throw new Error(`${label} Planning grid is misaligned: ${JSON.stringify(snapshot)}`);
      }
      const planningTopGap = snapshot.groups.top - snapshot.topbar.bottom;
      if (planningTopGap < 12 || planningTopGap > 16) {
        throw new Error(`${label} Planning starts ${planningTopGap}px below the topbar, expected 12–16px`);
      }
      const expectedWidth = mobile ? width - 20 : Math.min(900, width - 32);
      if (Math.abs(snapshot.workspace.width - expectedWidth) > alignmentTolerance) {
        throw new Error(`${label} workspace is ${snapshot.workspace.width}px wide, expected ${expectedWidth}px`);
      }
      if (snapshot.groupHeader.height !== 26 || snapshot.groupHeader.marginBottom !== "7px" || snapshot.groupGap !== "15px" || snapshot.taskMain.height !== 48) {
        throw new Error(`${label} Planning rhythm is incorrect: ${JSON.stringify({ header: snapshot.groupHeader, gap: snapshot.groupGap, row: snapshot.taskMain })}`);
      }
      if (snapshot.groupHeader.borderColor !== snapshot.lineColor) {
        throw new Error(`${label} overdue group divider is not neutral (${snapshot.groupHeader.borderColor} / ${snapshot.lineColor})`);
      }
      if (snapshot.icon.width !== 18 || snapshot.icon.height !== 18) {
        throw new Error(`${label} task action icon is not 18px (${snapshot.icon.width} × ${snapshot.icon.height})`);
      }
      if (snapshot.actionColors.delete !== snapshot.actionColors.neutral) {
        throw new Error(`${label} Delete is emphasized before interaction (${snapshot.actionColors.delete} / ${snapshot.actionColors.neutral})`);
      }
      if (snapshot.visibleAddCount !== 1 || (mobile
        ? snapshot.addVisibility.desktop || !snapshot.addVisibility.mobile || snapshot.addVisibility.group
        : !snapshot.addVisibility.desktop || snapshot.addVisibility.mobile || snapshot.addVisibility.group)) {
        throw new Error(`${label} does not expose exactly one persistent Add action: ${JSON.stringify(snapshot.addVisibility)}`);
      }
      console.log(`${label} Planning grid: ${snapshot.workspace.width}px, ${planningTopGap}px top gap, 26/7/15/48px rhythm, one persistent Add`);
    };
    await measurePlanningLayout("desktop", 1000, 900, false);
    await measurePlanningLayout("390×844 mobile", 390, 844, true);

    await page.send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.send("Page.navigate", { url: taskActionsUrl });
    await waitFor("document.querySelectorAll('.task-main').length === 3 && document.querySelectorAll('.task-actions.is-overflow').length === 2");

    const taskActionSnapshot = async () => {
      const measured = await page.send("Runtime.evaluate", {
        expression: `(() => {
          const rows = [...document.querySelectorAll('.task-main')];
          const rect = (element) => {
            const value = element.getBoundingClientRect();
            return { bottom: value.bottom, height: value.height, left: value.left, right: value.right, top: value.top, width: value.width };
          };
          return rows.map((row) => {
            const title = row.querySelector('.task-title');
            const actions = row.querySelector('.task-actions');
            const tray = actions.querySelector('.task-action-tray');
            return {
              row: { ...rect(row), clientWidth: row.clientWidth, scrollWidth: row.scrollWidth },
              title: { ...rect(title), overflow: getComputedStyle(title).textOverflow },
              actions: rect(actions),
              directCount: actions.querySelectorAll('.task-actions-direct button').length,
              trigger: actions.querySelector('.task-actions-trigger') ? {
                ...rect(actions.querySelector('.task-actions-trigger')),
                expanded: actions.querySelector('.task-actions-trigger').getAttribute('aria-expanded'),
                label: actions.querySelector('.task-actions-trigger').getAttribute('aria-label'),
                title: actions.querySelector('.task-actions-trigger').title
              } : null,
              tray: tray ? {
                ...rect(tray),
                background: getComputedStyle(tray).backgroundColor,
                buttons: [...tray.querySelectorAll('button')].map((button) => ({ ...rect(button), label: button.getAttribute('aria-label'), title: button.title }))
              } : null
            };
          });
        })()`,
        returnByValue: true
      });
      return measured.result.value;
    };

    const verifyClosedRows = (label, rows) => {
      const [shortRow, ...overflowRows] = rows;
      if (shortRow.directCount !== 4 || shortRow.trigger) throw new Error(`${label} short row did not preserve four direct actions: ${JSON.stringify(shortRow)}`);
      for (const row of overflowRows) {
        if (row.directCount !== 0 || !row.trigger || row.trigger.width < 44 || row.trigger.height < 44 || !row.trigger.label || !row.trigger.title) {
          throw new Error(`${label} long row did not collapse to one discoverable 44px trigger: ${JSON.stringify(row)}`);
        }
        if (row.row.scrollWidth > row.row.clientWidth || row.title.right > row.actions.left || row.title.overflow !== "ellipsis") {
          throw new Error(`${label} long row overlaps or overflows before opening: ${JSON.stringify(row)}`);
        }
      }
    };

    let taskRows = await taskActionSnapshot();
    verifyClosedRows("desktop", taskRows);
    console.log("desktop task actions: short row direct, two long rows collapsed, no overlap");

    await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await waitFor("document.querySelectorAll('.task-actions.is-overflow').length === 2");
    taskRows = await taskActionSnapshot();
    verifyClosedRows("390×844 mobile", taskRows);
    console.log("390×844 mobile task actions: short row direct, two long rows collapsed, no overlap");

    const evaluate = (expression) => page.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    await evaluate("document.querySelectorAll('.task-actions-trigger')[0].click(); new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    taskRows = await taskActionSnapshot();
    const openedRow = taskRows[1];
    if (!openedRow.tray || openedRow.tray.buttons.length !== 4 || openedRow.tray.right > openedRow.row.right || openedRow.tray.height !== 44 || openedRow.tray.background === "rgba(0, 0, 0, 0)") {
      throw new Error(`mobile action tray is not anchored, opaque, and 44px tall: ${JSON.stringify(openedRow)}`);
    }
    for (const action of openedRow.tray.buttons) {
      if (action.width < 44 || action.height < 44 || !action.label || !action.title) throw new Error(`tray action is not discoverable: ${JSON.stringify(action)}`);
    }

    await evaluate("document.querySelectorAll('.task-actions-trigger')[1].click(); new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    taskRows = await taskActionSnapshot();
    if (taskRows[1].tray || !taskRows[2].tray) throw new Error("opening another row did not close the previous action tray");

    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
    await delay(50);
    const escapeState = await evaluate("({ trays: document.querySelectorAll('.task-action-tray').length, focused: document.activeElement?.classList.contains('task-actions-trigger') })");
    if (escapeState.result.value.trays !== 0 || !escapeState.result.value.focused) throw new Error(`Escape did not dismiss and restore trigger focus: ${JSON.stringify(escapeState.result.value)}`);

    await evaluate("document.querySelectorAll('.task-actions-trigger')[0].click(); new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    await evaluate("document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); new Promise((resolve) => requestAnimationFrame(resolve))");
    const outsideState = await evaluate("document.querySelectorAll('.task-action-tray').length");
    if (outsideState.result.value !== 0) throw new Error("outside pointer did not dismiss the action tray");

    await evaluate("window.__deleteConfirmed = false; window.confirm = () => { window.__deleteConfirmed = true; return false; }; document.querySelectorAll('.task-actions-trigger')[0].click(); new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    await evaluate("document.querySelector('.task-action-tray .task-action.danger').click(); new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    const actionState = await evaluate("({ confirmed: window.__deleteConfirmed, trays: document.querySelectorAll('.task-action-tray').length, focused: document.activeElement?.classList.contains('task-actions-trigger') })");
    if (!actionState.result.value.confirmed || actionState.result.value.trays !== 0 || !actionState.result.value.focused) {
      throw new Error(`tray action did not confirm, close, and restore focus: ${JSON.stringify(actionState.result.value)}`);
    }

    await evaluate("document.querySelectorAll('.task-actions-trigger')[0].click(); new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    await evaluate("document.querySelector('#refresh-task-context').focus(); document.querySelector('#refresh-task-context').click(); new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    const contextState = await evaluate("({ trays: document.querySelectorAll('.task-action-tray').length, focused: document.activeElement?.id, overflow: document.querySelectorAll('.task-actions.is-overflow').length, actions: document.querySelectorAll('.task-main')[1].querySelector('.task-actions-probe').children.length })");
    if (contextState.result.value.trays !== 0 || contextState.result.value.focused !== "refresh-task-context" || contextState.result.value.overflow !== 2 || contextState.result.value.actions !== 3) {
      throw new Error(`retained row context refresh did not dismiss without restoring hidden trigger focus: ${JSON.stringify(contextState.result.value)}`);
    }

    await evaluate("document.querySelectorAll('.task-actions-trigger')[0].click(); new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    await evaluate("document.querySelector('.task-action-tray [title=\"Edit task\"]').click(); new Promise((resolve) => setTimeout(resolve, 50))");
    const editState = await evaluate("({ trays: document.querySelectorAll('.task-action-tray').length, dialogOpen: Boolean(document.querySelector('.task-editor[open]')), focused: document.activeElement?.classList.contains('editor-title') })");
    if (editState.result.value.trays !== 0 || !editState.result.value.dialogOpen || !editState.result.value.focused) {
      throw new Error(`Edit from tray did not preserve editor focus: ${JSON.stringify(editState.result.value)}`);
    }
    await evaluate("document.querySelector('.task-editor[open] .editor-done').click(); new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");

    await evaluate("document.querySelectorAll('.task-actions-trigger')[0].click(); new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    await evaluate("document.querySelector('.task-action-tray [title=\"Break down task\"]').click(); new Promise((resolve) => setTimeout(resolve, 50))");
    const breakdownState = await evaluate("({ trays: document.querySelectorAll('.task-action-tray').length, dialogOpen: Boolean(document.querySelector('.task-editor[open]')), disclosureOpen: Boolean(document.querySelector('.task-editor[open] .editor-disclosure:nth-of-type(2)[open]')), focused: document.activeElement?.matches('.task-editor[open] textarea') })");
    if (breakdownState.result.value.trays !== 0 || !breakdownState.result.value.dialogOpen || !breakdownState.result.value.disclosureOpen || !breakdownState.result.value.focused) {
      throw new Error(`Breakdown from tray did not preserve disclosure focus: ${JSON.stringify(breakdownState.result.value)}`);
    }
    console.log("task action tray: geometry, dismissal, retained-row refresh, confirmation, and Edit/Breakdown focus passed");
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
  await viteServer?.close();
  await rm(profile, { recursive: true, force: true });
}
