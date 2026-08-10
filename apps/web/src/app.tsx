import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { canonicalRules, compareRanks, type CommandResult, type Conflict, type DelegationInvite, type SyncEvent, type Task } from "@todorant/domain";
import {
  api,
  applyRemoteCommandResult,
  conflicts,
  connection,
  orderedTasks,
  pendingCount,
  pull,
  queueCommand,
  resolveConflict,
  syncErrors,
  retryFailedOperation,
  discardFailedOperation,
  startSync,
  stopSync
} from "./sync.js";
import { decryptTaskValue, encryptionPassphrase, encryptTaskFields } from "./encryption.js";

type Session = {
  user: { id: string; email: string };
  csrfToken: string;
  settings: Record<string, unknown>;
};

type ProductSettings = Record<string, unknown>;

const enabled = (settings: ProductSettings, key: string): boolean => settings[key] === true;

type ImportRun = {
  id: string;
  status: "queued" | "running" | "complete" | "failed";
  counts: Record<string, number>;
  errors: string[];
};

export function Landing({ onAuthenticated }: { onAuthenticated: (session: Session) => void }) {
  const [mode, setMode] = useState<"login" | "signup" | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: Event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    setBusy(true);
    setError("");
    try {
      const session = await api.request<Session>(`/api/auth/${mode}`, {
        method: "POST",
        body: JSON.stringify({ email: data.get("email"), password: data.get("password") })
      });
      onAuthenticated(session);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main class="landing">
      <div class="landing-inner">
        <span class="wordmark">todorant</span>
        <h1>The todo manager your friends told you about</h1>
        {mode ? (
          <form class="auth-card" onSubmit={submit}>
            <label>
              Email
              <input name="email" type="email" autocomplete="email" required autofocus />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                autocomplete={mode === "signup" ? "new-password" : "current-password"}
                minlength={10}
                required
              />
            </label>
            {error && <p class="error" role="alert">{error}</p>}
            <button class="primary" disabled={busy} type="submit">
              {busy ? "Working…" : mode === "signup" ? "Create account" : "Log in"}
            </button>
            <button class="quiet" type="button" onClick={() => setMode(null)}>Back</button>
          </form>
        ) : (
          <div class="landing-actions">
            <button class="primary" onClick={() => setMode("signup")}>Sign up</button>
            <button class="secondary" onClick={() => setMode("login")}>Log in</button>
          </div>
        )}
      </div>
    </main>
  );
}

export const productDate = (startTimeOfDay?: unknown, now = new Date()) => {
  const date = new Date(now);
  if (typeof startTimeOfDay === "string" && /^\d{2}:\d{2}$/u.test(startTimeOfDay)) {
    const boundary = new Date(now);
    const [hours, minutes] = startTimeOfDay.split(":").map(Number);
    boundary.setHours(hours ?? 0, minutes ?? 0, 0, 0);
    if (now < boundary) date.setDate(date.getDate() - 1);
  }
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

export const isActionableOn = (task: Task, date: string): boolean =>
  !task.skippedDates.includes(date) && (
    task.schedule.date ? task.schedule.date <= date : task.schedule.month === null
  );

export const requiresPlanningOn = (task: Task, date: string): boolean =>
  !task.deletedAt && !task.completedAt && (
    task.schedule.date ? task.schedule.date < date : Boolean(task.schedule.month && task.schedule.month <= date.slice(0, 7))
  );

export const planningGroupFor = (task: Task): string =>
  task.schedule.date ?? task.schedule.month ?? "Unscheduled";

export const canReorderPlanningTasks = (source: Task, target: Task): boolean =>
  planningGroupFor(source) === planningGroupFor(target);

export const planningReorderHelp =
  "Tasks can only be dragged within the same date or month group";

export function scheduleForNewTask(
  productDay: string,
  selectedDate: string | null,
  contextualMonth: string | null,
  scheduleToday: boolean,
  timezone: string
): Task["schedule"] {
  const nextMonth = new Date(`${productDay}T12:00:00`);
  nextMonth.setMonth(nextMonth.getMonth() + 1);
  const scheduleDate = selectedDate ?? (!contextualMonth && scheduleToday ? productDay : null);
  const scheduleMonth = scheduleDate?.slice(0, 7) ?? contextualMonth ??
    `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, "0")}`;
  return { month: scheduleMonth, date: scheduleDate, time: null, timezone };
}

const compareFocusOrder = (left: Task, right: Task, preserveOrderByTime: boolean): number =>
  Number(right.frog) - Number(left.frog) ||
  (preserveOrderByTime ? (left.schedule.time ?? "99:99").localeCompare(right.schedule.time ?? "99:99") : 0) ||
  compareRanks(left.rank, right.rank);

export function TaskRow({
  task,
  index,
  all,
  current,
  expanded,
  onExpand,
  settings,
  currentUserId,
  reorderEnabled = false,
  onDragStart,
  onDrop
}: {
  task: Task;
  index: number;
  all: Task[];
  current: boolean;
  expanded: boolean;
  onExpand: () => void;
  settings: ProductSettings;
  currentUserId: string;
  reorderEnabled?: boolean;
  onDragStart?: () => void;
  onDrop?: () => void;
}) {
  const [text, setText] = useState(task.encryption ? "Encrypted task" : task.text);
  const [note, setNote] = useState(task.encryption ? "" : task.note);
  const [breakdown, setBreakdown] = useState("");
  const [delegateEmail, setDelegateEmail] = useState("");
  const [delegationError, setDelegationError] = useState("");
  const [history, setHistory] = useState<SyncEvent[] | null>(null);
  const [encryptionUnlocked, setEncryptionUnlocked] = useState(task.encryption === null);
  useEffect(() => {
    if (!task.encryption) {
      setEncryptionUnlocked(true);
      setText(task.text);
      setNote(task.note);
      return;
    }
    const passphrase = encryptionPassphrase.value;
    if (!passphrase) {
      setEncryptionUnlocked(false);
      setText(task.encryption.algorithm === "legacy-aes" ? "Legacy encrypted task · enter legacy password in Settings" : "Encrypted task · enter key in Settings");
      setNote("");
      return;
    }
    void Promise.all([
      decryptTaskValue(task.text, passphrase, task.encryption.algorithm),
      task.note ? decryptTaskValue(task.note, passphrase, task.encryption.algorithm) : Promise.resolve("")
    ])
      .then(([plainText, plainNote]) => {
        setEncryptionUnlocked(true);
        setText(plainText);
        setNote(plainNote);
      })
      .catch(() => {
        setEncryptionUnlocked(false);
        setText("Encrypted task · wrong key");
        setNote("");
      });
  }, [task.text, task.note, task.encryption, encryptionPassphrase.value]);

  const saveText = async () => {
    const value = text.trim();
    if (value && !task.encryption && value !== task.text) await queueCommand(task.id, "update", { text: value });
    else if (value && task.encryption && encryptionPassphrase.value) {
      const fields = await encryptTaskFields(value, note, encryptionPassphrase.value);
      await queueCommand(task.id, "update", fields);
    }
    else setText(task.text);
  };
  const move = (direction: -1 | 1) => {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= all.length) return;
    const ordering =
      direction < 0
        ? { afterId: all[targetIndex - 1]?.id ?? null, beforeId: all[targetIndex]?.id ?? null }
        : { afterId: all[targetIndex]?.id ?? null, beforeId: all[targetIndex + 1]?.id ?? null };
    void queueCommand(task.id, "reorder", {}, { ordering });
  };
  const setTags = (value: string) => {
    const next = [...new Set(value.split(",").map((tag) => tag.trim()).filter(Boolean))];
    void queueCommand(task.id, "tags", {}, {
      tagChanges: { add: next.filter((tag) => !task.tags.includes(tag)), remove: task.tags.filter((tag) => !next.includes(tag)) }
    });
  };
  const copyTask = async () => {
    const taskId = crypto.randomUUID();
    await queueCommand(taskId, "create", {
      text: task.text,
      note: task.note,
      schedule: task.schedule,
      repetitive: task.repetitive,
      frog: false,
      parentId: task.parentId
    });
    if (task.tags.length) {
      await queueCommand(taskId, "tags", {}, { tagChanges: { add: task.tags, remove: [] } });
    }
  };
  const complete = async () => {
    if (task.repetitive && window.confirm("Copy this repetitive task as a new conscious occurrence before completing it?")) {
      await copyTask();
    }
    await queueCommand(task.id, task.completedAt ? "reopen" : "complete");
  };
  const breakDown = async () => {
    const subtasks = breakdown.split("\n").map((item) => item.trim()).filter(Boolean);
    if (!subtasks.length) return;
    for (const subtask of subtasks) {
      const taskId = crypto.randomUUID();
      await queueCommand(taskId, "create", {
        text: subtask,
        schedule: task.schedule,
        repetitive: false,
        parentId: task.id
      });
      if (task.tags.length && enabled(settings, "duplicateTagInBreakdown")) {
        await queueCommand(taskId, "tags", {}, { tagChanges: { add: task.tags, remove: [] } });
      }
    }
    setBreakdown("");
    if (!task.completedAt) await queueCommand(task.id, "complete");
  };
  const delegate = async () => {
    setDelegationError("");
    try {
      const result = await api.request<{ userId: string }>("/api/delegates/resolve", {
        method: "POST",
        body: JSON.stringify({ email: delegateEmail })
      });
      await queueCommand(task.id, "delegate-assign", {}, { delegationUserId: result.userId });
      setDelegateEmail("");
    } catch (error) {
      setDelegationError(error instanceof Error ? error.message : "Unable to delegate this task");
    }
  };
  const revokeDelegation = async () => {
    setDelegationError("");
    try {
      await queueCommand(task.id, "delegate-revoke");
    } catch (error) {
      setDelegationError(error instanceof Error ? error.message : "Unable to revoke this delegation");
    }
  };

  return (
    <li
      class={`task ${task.completedAt ? "is-complete" : ""} ${current ? "is-current" : ""} ${requiresPlanningOn(task, productDate(settings.startTimeOfDay)) ? "is-overdue" : ""} ${reorderEnabled ? "is-reorderable" : ""}`}
      draggable={reorderEnabled}
      onDragStart={onDragStart}
      onDragOver={(event) => { if (reorderEnabled) event.preventDefault(); }}
      onDrop={(event) => { event.preventDefault(); onDrop?.(); }}
    >
      <div class="task-main">
        <button
          class="check"
          aria-label={task.completedAt ? `Reopen ${task.text}` : `Complete ${task.text}`}
          aria-pressed={task.completedAt !== null}
          onClick={() => void complete()}
        >
          {task.completedAt ? "✓" : ""}
        </button>
        <input
          class="task-title"
          value={text}
          disabled={task.encryption !== null && !encryptionUnlocked}
          aria-label="Task title"
          onInput={(event) => setText(event.currentTarget.value)}
          onBlur={() => void saveText()}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setText(task.text);
              event.currentTarget.blur();
            }
          }}
        />
        {task.frog && <span class="badge" title="Frog task">frog</span>}
        {current && !task.frog && <span class="badge" title="Current focus">current</span>}
        {task.repetitive && <span class="indicator" title="Conscious repetitive task">↻</span>}
        {task.skippedDates.length > 0 && <span class="indicator" title={`Skipped ${task.skippedDates.length} times`}>↷</span>}
        {task.encryption && <span class="indicator" title="Encrypted task">◆</span>}
        {task.frogFails > 0 && <span class="frog-marks" aria-label={`${task.frogFails} redistributions`} title={`${task.frogFails} redistributions`}>{"●".repeat(Math.min(task.frogFails, 3))}</span>}
        {(task.schedule.date || task.schedule.month) && <time class="date" dateTime={task.schedule.date ?? task.schedule.month ?? undefined}>{task.schedule.date ?? task.schedule.month}{task.schedule.time ? ` · ${task.schedule.time}` : ""}</time>}
        <button class="icon-button" aria-label={`Details for ${task.text}`} aria-expanded={expanded} onClick={onExpand}>•••</button>
      </div>
      {expanded && (
        <div class="task-details">
          <label class="wide">
            Note
            <textarea
              value={note}
              disabled={task.encryption !== null && !encryptionUnlocked}
              rows={2}
              onInput={(event) => setNote(event.currentTarget.value)}
              onBlur={(event) => {
                if (!task.encryption && event.currentTarget.value !== task.note) void queueCommand(task.id, "update", { note: event.currentTarget.value });
                if (task.encryption && encryptionPassphrase.value) {
                  void encryptTaskFields(text, event.currentTarget.value, encryptionPassphrase.value)
                    .then((fields) => queueCommand(task.id, "update", fields));
                }
              }}
            />
          </label>
          <label>
            Schedule
            <input
              type="date"
              value={task.schedule.date ?? ""}
              onInput={(event) =>
                void queueCommand(task.id, "update", {
                  schedule: {
                    ...task.schedule,
                    month: event.currentTarget.value ? event.currentTarget.value.slice(0, 7) : task.schedule.month,
                    date: event.currentTarget.value || null
                  }
                })
              }
            />
          </label>
          <label>
            Planning month
            <input
              type="month"
              value={task.schedule.month ?? ""}
              onInput={(event) => {
                const month = event.currentTarget.value || null;
                const currentDate = productDate(settings.startTimeOfDay);
                void queueCommand(task.id, "update", {
                  schedule: { ...task.schedule, month, date: month === currentDate.slice(0, 7) ? currentDate : null }
                });
              }}
            />
          </label>
          <label>
            Exact time
            <input
              type="time"
              value={task.schedule.time ?? ""}
              onInput={(event) => void queueCommand(task.id, "update", {
                schedule: { ...task.schedule, time: event.currentTarget.value || null }
              })}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={task.repetitive}
              onInput={(event) => void queueCommand(task.id, "update", { repetitive: event.currentTarget.checked })}
            />
            Repetitive (copy or break down consciously)
          </label>
          <label>
            Tags
            <input defaultValue={task.tags.join(", ")} onBlur={(event) => setTags(event.currentTarget.value)} />
          </label>
          <label class="wide">
            Break down into subtasks (one per line)
            <textarea value={breakdown} rows={2} onInput={(event) => setBreakdown(event.currentTarget.value)} />
            <button disabled={!breakdown.trim()} onClick={() => void breakDown()}>Create subtasks and complete parent</button>
          </label>
          {task.userId === currentUserId && task.delegation && ["pending", "accepted"].includes(task.delegation.status) ? (
            <div class="wide">
              <p class="meta">Delegation {task.delegation.status}</p>
              <button onClick={() => void revokeDelegation()}>Revoke delegation</button>
            </div>
          ) : task.userId === currentUserId ? (
            <label class="wide">
              Delegate to an existing account
              <span class="inline-fields"><input type="email" value={delegateEmail} placeholder="person@example.com" onInput={(event) => setDelegateEmail(event.currentTarget.value)} /><button disabled={!delegateEmail} onClick={() => void delegate()}>Delegate</button></span>
            </label>
          ) : (
            <p class="meta wide">Delegated to you · accepted</p>
          )}
          {delegationError && <p class="error wide" role="alert">{delegationError}</p>}
          <div class="detail-actions wide">
            <button onClick={() => void queueCommand(task.id, "update", { frog: !task.frog })}>{task.frog ? "Unmark frog" : "Mark frog"}</button>
            {!task.encryption && <button disabled={encryptionPassphrase.value.length < 12} title={encryptionPassphrase.value.length < 12 ? "Set an encryption key in Settings first" : undefined} onClick={() => void encryptTaskFields(text, note, encryptionPassphrase.value).then((fields) => queueCommand(task.id, "update", fields))}>Encrypt task</button>}
            {task.repetitive && <button onClick={() => void copyTask()}>Copy occurrence</button>}
            <button disabled={task.frog} title={task.frog ? "Frogs cannot be skipped" : undefined} onClick={() => void queueCommand(task.id, "skip", {}, { skipDate: productDate(settings.startTimeOfDay) })}>Skip</button>
            <button aria-label="Move task up" disabled={index === 0} onClick={() => move(-1)}>↑</button>
            <button aria-label="Move task down" disabled={index === all.length - 1} onClick={() => move(1)}>↓</button>
            <button class="danger" onClick={() => void queueCommand(task.id, "delete")}>Delete</button>
          </div>
          <p class="meta wide">Revision {task.revision} · Owner {task.ownerId.slice(0, 8)} · {task.encryption ? `Encrypted (${task.encryption.algorithm})` : "Encryption ready"}</p>
          {task.legacyDelegation && <p class="meta wide">Imported delegation · legacy delegator {task.legacyDelegation.delegatorId?.slice(0, 8)} · {task.legacyDelegation.accepted === true ? "accepted" : "pending"}</p>}
          <div class="wide">
            <button class="quiet" onClick={() => void api.request<{ events: SyncEvent[] }>(`/api/tasks/${task.id}/history`).then((value) => setHistory(value.events))}>{history ? "Refresh history" : "Load immutable history"}</button>
            {history && <ol class="history">{history.map((event) => <li key={event.cursor}>Revision {event.task.revision}{event.conflict ? ` · conflict on ${event.conflict.fields.join(", ")}` : ""}</li>)}</ol>}
          </div>
        </div>
      )}
    </li>
  );
}

function RulesPanel({ close }: { close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => dialog.current?.showModal(), []);
  return (
    <dialog ref={dialog} class="panel" onClose={close}>
      <header><div><span class="eyebrow">Main rules</span><h2>How to use Todorant</h2></div><button class="icon-button" aria-label="Close rules" onClick={() => dialog.current?.close()}>×</button></header>
      <ol class="rules">{canonicalRules.map((rule) => <li key={rule}>{rule}</li>)}</ol>
    </dialog>
  );
}

function ConflictPanel({ items }: { items: Conflict[] }) {
  if (!items.length) return null;
  return (
    <aside class="conflicts" aria-label="Sync conflicts">
      <strong>Review {items.length} sync {items.length === 1 ? "conflict" : "conflicts"}</strong>
      {items.map((conflict) => (
        <div key={conflict.id}>
          <span>{conflict.fields.join(", ")} changed elsewhere.</span>
          <button onClick={() => void resolveConflict(conflict, false)}>Keep current</button>
          <button onClick={() => void resolveConflict(conflict, true)}>Restore mine</button>
        </div>
      ))}
    </aside>
  );
}

function SyncErrorPanel() {
  if (!syncErrors.value.length) return null;
  return (
    <aside class="conflicts" aria-label="Queued changes needing review">
      <strong>Review {syncErrors.value.length} queued {syncErrors.value.length === 1 ? "change" : "changes"}</strong>
      {syncErrors.value.map((operation) => (
        <div key={operation.operationId}>
          <span>{operation.error ?? "The server rejected this change."}</span>
          <button onClick={() => void retryFailedOperation(operation.operationId)}>Retry</button>
          <button onClick={() => void discardFailedOperation(operation.operationId)}>Discard this change</button>
        </div>
      ))}
    </aside>
  );
}

function SettingsPanel({
  session,
  settings,
  updateSettings,
  close
}: {
  session: Session;
  settings: ProductSettings;
  updateSettings: (settings: ProductSettings) => void;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [run, setRun] = useState<ImportRun | null>(null);
  const [legacyToken, setLegacyToken] = useState("");
  const [passphrase, setPassphrase] = useState(encryptionPassphrase.value);
  useEffect(() => {
    dialog.current?.showModal();
    void api.request<{ run: ImportRun | null }>("/api/import").then((result) => setRun(result.run));
  }, []);
  const setTheme = async (theme: string) => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    updateSettings(await api.request<ProductSettings>("/api/settings", { method: "PATCH", body: JSON.stringify({ theme }) }));
  };
  const setProductSetting = async (key: string, value: boolean | number | string) => {
    updateSettings(await api.request<ProductSettings>("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ [key]: value })
    }));
  };
  const beginImport = async () => {
    const created = await api.request<ImportRun>("/api/import", {
      method: "POST",
      body: JSON.stringify({ legacyToken })
    });
    setLegacyToken("");
    setRun(created);
    const poll = window.setInterval(() => {
      void api.request<{ run: ImportRun | null }>("/api/import").then((result) => {
        setRun(result.run);
        if (result.run?.status === "complete" || result.run?.status === "failed") {
          window.clearInterval(poll);
          void Promise.all([pull(), api.request<ProductSettings>("/api/settings")]).then(([, imported]) => updateSettings(imported));
        }
      });
    }, 1200);
  };
  return (
    <dialog ref={dialog} class="panel" onClose={close}>
      <header><div><span class="eyebrow">Account</span><h2>Settings</h2></div><button class="icon-button" aria-label="Close settings" onClick={() => dialog.current?.close()}>×</button></header>
      <p class="account-email">{session.user.email}</p>
      <label>
        Appearance
        <select value={String(settings.theme ?? "system")} onInput={(event) => void setTheme(event.currentTarget.value)}>
          <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
        </select>
      </label>
      <section class="settings-section">
        <h3>Planning behavior</h3>
        <label><input type="checkbox" checked={enabled(settings, "showTodayOnAddTodo")} onInput={(event) => void setProductSetting("showTodayOnAddTodo", event.currentTarget.checked)} /> Default new tasks to today</label>
        <label><input type="checkbox" checked={enabled(settings, "newTodosGoFirst")} onInput={(event) => void setProductSetting("newTodosGoFirst", event.currentTarget.checked)} /> Put new tasks first</label>
        <label><input type="checkbox" checked={enabled(settings, "preserveOrderByTime")} onInput={(event) => void setProductSetting("preserveOrderByTime", event.currentTarget.checked)} /> Preserve exact-time order</label>
        <label><input type="checkbox" checked={enabled(settings, "showMoreByDefault")} onInput={(event) => void setProductSetting("showMoreByDefault", event.currentTarget.checked)} /> Open task details by default</label>
        <label><input type="checkbox" checked={enabled(settings, "duplicateTagInBreakdown")} onInput={(event) => void setProductSetting("duplicateTagInBreakdown", event.currentTarget.checked)} /> Copy tags into subtasks</label>
        <label>First day of week<select value={String(settings.firstDayOfWeek ?? 1)} onInput={(event) => void setProductSetting("firstDayOfWeek", Number(event.currentTarget.value))}><option value="0">Sunday</option><option value="1">Monday</option><option value="6">Saturday</option></select></label>
        <label>Start of Todorant day<input type="time" value={String(settings.startTimeOfDay ?? "00:00")} onInput={(event) => void setProductSetting("startTimeOfDay", event.currentTarget.value)} /></label>
      </section>
      <section class="settings-section">
        <h3>Encryption</h3>
        <label>Local encryption key<input type="password" minlength={12} autocomplete="off" spellcheck={false} value={passphrase} placeholder="Not sent to the server" onInput={(event) => { setPassphrase(event.currentTarget.value); encryptionPassphrase.value = event.currentTarget.value; }} /></label>
        <p class="meta">The key stays in this browser session. Losing it makes encrypted task text unrecoverable.</p>
      </section>
      <section class="settings-section">
        <h3>Data</h3>
        <div class="stack-actions">
          <a class="secondary button-link" href="/api/export" download>Export my data</a>
          <label>Legacy access token<input type="password" autocomplete="off" spellcheck={false} value={legacyToken} onInput={(event) => setLegacyToken(event.currentTarget.value)} /></label>
          <button class="secondary" disabled={legacyToken.length < 16 || run?.status === "queued" || run?.status === "running"} onClick={() => void beginImport()}>Verify and import from Todorant</button>
        </div>
        {run && <p class="import-status" role="status">Import {run.status}{run.status === "complete" ? ` · ${Object.values(run.counts).reduce((sum, count) => sum + count, 0)} records` : ""}{run.errors[0] ? ` · ${run.errors[0]}` : ""}</p>}
      </section>
    </dialog>
  );
}

type TaskView = "current" | "today" | "planning" | "delegation" | "all" | "reports" | "trash";

function ReportPanel({ all }: { all: Task[] }) {
  const [shareUrl, setShareUrl] = useState("");
  const completed = all.filter((task) => task.completedAt && !task.deletedAt);
  const byDate = new Map<string, { tasks: number; frogs: number }>();
  for (const task of completed) {
    const date = task.schedule.date ?? task.completedAt?.slice(0, 10) ?? "Unscheduled";
    const value = byDate.get(date) ?? { tasks: 0, frogs: 0 };
    value.tasks += 1;
    if (task.frog) value.frogs += 1;
    byDate.set(date, value);
  }
  return (
    <section class="report" aria-label="Completion report">
      <p><strong>{completed.length}</strong> completed · <strong>{completed.filter((task) => task.frog).length}</strong> frogs</p>
      <button onClick={() => void api.request<{ id: string }>("/api/report/share", { method: "POST" }).then((value) => setShareUrl(`${location.origin}/api/report/public/${value.id}`))}>Create public aggregate report</button>
      {shareUrl && <p><a href={shareUrl} target="_blank" rel="noreferrer">{shareUrl}</a></p>}
      <ul>{[...byDate].sort(([a], [b]) => b.localeCompare(a)).map(([date, value]) => <li key={date}><time>{date}</time><span>{value.tasks} tasks · {value.frogs} frogs</span></li>)}</ul>
    </section>
  );
}

export function Workspace({ session, logout }: { session: Session; logout: () => void }) {
  const [settings, setSettings] = useState<ProductSettings>(session.settings);
  const [filter, setFilter] = useState<TaskView>("current");
  const [search, setSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [addDate, setAddDate] = useState("");
  const [addMonth, setAddMonth] = useState("");
  const [showCompleted, setShowCompleted] = useState(false);
  const [planningMonth, setPlanningMonth] = useState("");
  const [reorderEnabled, setReorderEnabled] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [invitations, setInvitations] = useState<DelegationInvite[]>([]);
  const [invitationError, setInvitationError] = useState("");
  const initializedDefaultExpansion = useRef(false);
  const quickAddInput = useRef<HTMLInputElement>(null);
  const date = productDate(settings.startTimeOfDay);
  const refreshInvitations = async () => {
    const result = await api.request<{ invitations: DelegationInvite[] }>("/api/delegations/invitations").catch(() => null);
    if (result) setInvitations(result.invitations);
  };
  useEffect(() => {
    void refreshInvitations();
    const timer = window.setInterval(() => void refreshInvitations(), 10_000);
    return () => window.clearInterval(timer);
  }, []);
  const respondToInvitation = async (invitation: DelegationInvite, response: "accept" | "reject") => {
    setInvitationError("");
    try {
      const init = {
        method: "POST",
        body: JSON.stringify({ operationId: crypto.randomUUID(), baseRevision: invitation.revision })
      };
      if (response === "accept") {
        await applyRemoteCommandResult(await api.request<CommandResult>(`/api/delegations/${invitation.taskId}/accept`, init));
      } else {
        await api.request(`/api/delegations/${invitation.taskId}/reject`, init);
      }
      await refreshInvitations();
    } catch (error) {
      setInvitationError(error instanceof Error ? error.message : "Unable to respond to this invitation");
    }
  };
  useEffect(() => {
    if (!initializedDefaultExpansion.current && enabled(settings, "showMoreByDefault") && orderedTasks.value[0]) {
      initializedDefaultExpansion.current = true;
      setExpanded(orderedTasks.value[0].id);
    }
  }, [orderedTasks.value, settings.showMoreByDefault]);
  const planningRequired = orderedTasks.value.some(
    (task) => requiresPlanningOn(task, date)
  );
  const todayTasks = orderedTasks.value.filter((task) =>
    !task.deletedAt &&
    isActionableOn(task, date) &&
    (!task.completedAt || task.schedule.date === date || task.completedAt.slice(0, 10) === date)
  );
  const completedToday = todayTasks.filter((task) => task.completedAt).length;
  useEffect(() => {
    const navigateByKeyboard = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable=true]") || event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLocaleLowerCase();
      if (key === "c") setFilter("current");
      if (key === "t") setFilter("today");
      if (key === "p") setFilter("planning");
      if (key === "a") {
        setAddOpen(true);
        window.setTimeout(() => quickAddInput.current?.focus(), 0);
      }
      if (key === "?") setRulesOpen(true);
    };
    window.addEventListener("keydown", navigateByKeyboard);
    return () => window.removeEventListener("keydown", navigateByKeyboard);
  }, []);
  const list = useMemo(() => {
    const visible = orderedTasks.value.filter((task) => (filter === "trash" ? task.deletedAt : !task.deletedAt));
    const matching = search.trim() && filter !== "current"
      ? visible.filter((task) => `${task.text} ${task.note} ${task.tags.join(" ")}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
      : visible;
    if (filter === "current") {
      if (planningRequired) return [];
      return matching
        .filter((task) => !task.completedAt && isActionableOn(task, date))
        .sort((a, b) => compareFocusOrder(a, b, enabled(settings, "preserveOrderByTime")))
        .slice(0, 1);
    }
    if (filter === "today") {
      return matching
        .filter((task) => todayTasks.some((todayTask) => todayTask.id === task.id))
        .filter((task) => showCompleted || !task.completedAt)
        .sort((a, b) => Number(Boolean(a.completedAt)) - Number(Boolean(b.completedAt)) || compareFocusOrder(a, b, enabled(settings, "preserveOrderByTime")));
    }
    if (filter === "planning") {
      return matching
        .filter((task) => (showCompleted || !task.completedAt) && (task.schedule.month !== null || task.schedule.date !== null))
        .filter((task) => !planningMonth || (task.schedule.date ?? task.schedule.month ?? "").startsWith(planningMonth))
        .sort((a, b) => {
          const left = a.schedule.date ?? `${a.schedule.month ?? "9999-99"}-99`;
          const right = b.schedule.date ?? `${b.schedule.month ?? "9999-99"}-99`;
          return left.localeCompare(right) || compareRanks(a.rank, b.rank);
        });
    }
    if (filter === "delegation") return matching.filter((task) => task.delegation !== null);
    return matching;
  }, [orderedTasks.value, filter, search, planningRequired, date, settings.preserveOrderByTime, showCompleted, planningMonth, todayTasks]);

  const planningGroups = useMemo(() => {
    const groups = new Map<string, Task[]>();
    for (const task of list) {
      const key = planningGroupFor(task);
      groups.set(key, [...(groups.get(key) ?? []), task]);
    }
    return [...groups];
  }, [list]);

  const dropTaskBefore = (targetId: string) => {
    if (!draggingId || draggingId === targetId) return;
    const source = list.find((task) => task.id === draggingId);
    const target = list.find((task) => task.id === targetId);
    if (!source || !target || !canReorderPlanningTasks(source, target)) {
      setDraggingId(null);
      return;
    }
    const group = planningGroupFor(target);
    const withoutSource = list.filter((task) => task.id !== draggingId && planningGroupFor(task) === group);
    const insertion = withoutSource.findIndex((task) => task.id === targetId);
    void queueCommand(draggingId, "reorder", {}, {
      ordering: {
        afterId: withoutSource[insertion - 1]?.id ?? null,
        beforeId: withoutSource[insertion]?.id ?? null
      }
    });
    setDraggingId(null);
  };

  const create = async (event: Event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const input = form.elements.namedItem("task") as HTMLInputElement;
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    const selectedDate = (form.elements.namedItem("date") as HTMLInputElement).value || null;
    const selectedTime = (form.elements.namedItem("time") as HTMLInputElement).value || null;
    const schedule = scheduleForNewTask(
      date,
      selectedDate,
      addMonth || null,
      enabled(settings, "showTodayOnAddTodo"),
      Intl.DateTimeFormat().resolvedOptions().timeZone
    );
    const protectedFields = encryptionPassphrase.value.length >= 12
      ? await encryptTaskFields(text, "", encryptionPassphrase.value)
      : { text };
    await queueCommand(crypto.randomUUID(), "create", {
      ...protectedFields,
      schedule: { ...schedule, time: selectedTime }
    }, enabled(settings, "newTodosGoFirst") ? { ordering: { afterId: null, beforeId: orderedTasks.value[0]?.id ?? null } } : {});
    setAddOpen(false);
    setAddDate("");
    setAddMonth("");
  };

  return (
    <div class="shell">
      <header class="topbar">
        <button class="wordmark wordmark-button" onClick={() => setFilter("current")}>todorant</button>
        <nav class="primary-nav" aria-label="Todorant workflow">
          {([ ["current", "Current"], ["planning", "Planning"], ["reports", "Report"], ["delegation", "Delegation"] ] as const).map(([view, label]) => (
            <button key={view} class={filter === view || (view === "planning" && filter === "today") ? "active" : ""} aria-current={filter === view || (view === "planning" && filter === "today") ? "page" : undefined} aria-keyshortcuts={view === "current" ? "C" : view === "planning" ? "P" : undefined} onClick={() => setFilter(view)}>{label}</button>
          ))}
        </nav>
        <div class="top-actions">
          <span class={`sync ${connection.value}`} title={`${pendingCount.value} queued operations`}>{connection.value}{pendingCount.value ? ` · ${pendingCount.value}` : ""}</span>
          <button aria-keyshortcuts="?" onClick={() => setRulesOpen(true)}>Rules</button>
          <details class="more-menu"><summary aria-label="More actions">More</summary><div><button onClick={() => setFilter("all")}>All tasks</button><button onClick={() => setFilter("trash")}>Trash</button><button onClick={logout}>Log out</button></div></details>
          <button aria-label="Open settings" onClick={() => setSettingsOpen(true)}>⚙</button>
        </div>
      </header>
      <main class="workspace">
        <div class="list-header"><div><span class="eyebrow">{filter === "current" ? "One thing at a time" : filter === "planning" || filter === "today" ? "Trust the system" : "Todorant"}</span><h1>{filter === "reports" ? "Report" : filter === "today" ? "Planning · Today" : `${filter[0]?.toUpperCase()}${filter.slice(1)}`}</h1></div><div class="header-actions"><span class="count">{list.length}</span>{!(["reports", "trash"] as TaskView[]).includes(filter) && <button class="add-context" aria-keyshortcuts="A" onClick={() => { const today = enabled(settings, "showTodayOnAddTodo"); setAddDate(today ? date : ""); setAddMonth(today ? date.slice(0, 7) : ""); setAddOpen(true); window.setTimeout(() => quickAddInput.current?.focus(), 0); }}>＋ Add task</button>}</div></div>
        {filter === "current" && <section class="day-progress" aria-label={`${completedToday} of ${todayTasks.length} tasks completed today`}><span>{completedToday} / {todayTasks.length} today</span><progress max={Math.max(todayTasks.length, 1)} value={completedToday} /></section>}
        {filter === "current" && planningRequired && <aside class="planning-lock"><strong>Planning comes first.</strong><span>Redistribute overdue work before returning to Current.</span><button class="primary" onClick={() => setFilter("planning")}>Open Planning</button></aside>}
        {(filter === "planning" || filter === "today") && <div class="planning-tools" role="toolbar" aria-label="Planning controls"><button class={filter === "today" ? "active" : ""} aria-pressed={filter === "today"} onClick={() => setFilter(filter === "today" ? "planning" : "today")}>Today</button><label class="month-control"><span>Calendar month</span><input type="month" value={planningMonth} onInput={(event) => { setPlanningMonth(event.currentTarget.value); setFilter("planning"); }} /></label><button aria-pressed={showCompleted} onClick={() => setShowCompleted(!showCompleted)}>{showCompleted ? "Hide completed" : "Completed"}</button><button aria-pressed={reorderEnabled} title={planningReorderHelp} onClick={() => setReorderEnabled(!reorderEnabled)}>{reorderEnabled ? "Done ordering" : "Reorder"}</button></div>}
        {reorderEnabled && filter === "planning" && <p class="meta">Drag tasks within the same date or month group. Change a task’s schedule to move it between groups.</p>}
        {filter !== "current" && filter !== "reports" && <input class="search" type="search" value={search} placeholder="Search tasks, notes, and tags" aria-label="Search tasks" onInput={(event) => setSearch(event.currentTarget.value)} />}
        {addOpen && (
          <form class="quick-add" onSubmit={(event) => void create(event)}>
            <input ref={quickAddInput} name="task" aria-label="New task" aria-keyshortcuts="A" placeholder="Capture an actionable task…" autocomplete="off" />
            {addMonth && !addDate && <span class="meta">Planning month: {addMonth}</span>}
            <input name="date" aria-label="New task date" type="date" value={addDate} onInput={(event) => setAddDate(event.currentTarget.value)} />
            <input name="time" aria-label="New task exact time" type="time" />
            <button class="primary" type="submit">Add</button>
            <button type="button" onClick={() => { setAddOpen(false); setAddDate(""); setAddMonth(""); }}>Cancel</button>
          </form>
        )}
        {filter === "planning" && <p class="meta">Weeks start {Number(settings.firstDayOfWeek ?? 1) === 0 ? "Sunday" : Number(settings.firstDayOfWeek ?? 1) === 6 ? "Saturday" : "Monday"} · Todorant day starts {String(settings.startTimeOfDay ?? "00:00")}</p>}
        <ConflictPanel items={conflicts.value} />
        <SyncErrorPanel />
        {filter === "delegation" && invitations.length > 0 && (
          <aside class="conflicts" aria-label="Delegation invitations">
            <strong>Delegation invitations</strong>
            {invitations.map((invitation) => (
              <div key={invitation.taskId}>
                <span>{invitation.ownerEmail} invited you to collaborate on a task.</span>
                <button onClick={() => void respondToInvitation(invitation, "accept")}>Accept</button>
                <button onClick={() => void respondToInvitation(invitation, "reject")}>Reject</button>
              </div>
            ))}
            {invitationError && <p class="error" role="alert">{invitationError}</p>}
          </aside>
        )}
        {filter === "reports" ? <ReportPanel all={orderedTasks.value} /> : filter === "planning" && list.length ? (
          <div class="planning-groups">
            {planningGroups.map(([group, groupTasks]) => <section class="planning-group" key={group}><header><div><span>{group.length === 7 ? "Month" : group < date ? "Overdue" : group === date ? "Today" : "Scheduled"}</span><h2>{group}</h2></div><button aria-label={`Add task for ${group}`} onClick={() => { setAddDate(group.length === 10 ? group : ""); setAddMonth(group.slice(0, 7)); setAddOpen(true); window.setTimeout(() => quickAddInput.current?.focus(), 0); }}>＋</button></header><ul class="task-list">{groupTasks.map((task, index) => <TaskRow key={task.id} task={task} index={index} all={groupTasks} current={false} expanded={expanded === task.id} onExpand={() => setExpanded(expanded === task.id ? null : task.id)} settings={settings} currentUserId={session.user.id} reorderEnabled={reorderEnabled} onDragStart={() => setDraggingId(task.id)} onDrop={() => dropTaskBefore(task.id)} />)}</ul></section>)}
          </div>
        ) : list.length ? (
          <ul class="task-list">
            {list.map((task, index) =>
              filter === "trash" ? (
                <li class="task trash-row" key={task.id}><span>{task.text}</span><button onClick={() => void queueCommand(task.id, "restore")}>Restore</button></li>
              ) : (
                <TaskRow key={task.id} task={task} index={index} all={list} current={filter === "current" && index === 0 && !task.completedAt} expanded={expanded === task.id} onExpand={() => setExpanded(expanded === task.id ? null : task.id)} settings={settings} currentUserId={session.user.id} />
              )
            )}
          </ul>
        ) : (
          <p class="empty">{filter === "current" && planningRequired ? "Current is locked until planning is complete." : filter === "current" ? "All done for now. Enjoy the clear mind." : "Nothing here. Your list has room to breathe."}</p>
        )}
      </main>
      <footer><span>Local-first · revisioned history</span><button class="quiet" onClick={logout}>Log out</button></footer>
      <nav class="mobile-nav" aria-label="Mobile Todorant workflow">{([ ["current", "Current"], ["planning", "Planning"], ["reports", "Report"], ["delegation", "Delegation"] ] as const).map(([view, label]) => <button key={view} class={filter === view || (view === "planning" && filter === "today") ? "active" : ""} onClick={() => setFilter(view)}><span aria-hidden="true">{view === "current" ? "●" : view === "planning" ? "▦" : view === "reports" ? "↗" : "↔"}</span>{label}</button>)}</nav>
      {rulesOpen && <RulesPanel close={() => setRulesOpen(false)} />}
      {settingsOpen && <SettingsPanel session={session} settings={settings} updateSettings={setSettings} close={() => setSettingsOpen(false)} />}
    </div>
  );
}

export function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    void api
      .request<Session>("/api/auth/session")
      .then((value) => {
        setSession(value);
        api.setCsrf(value.csrfToken);
        if (value.settings.theme === "dark") document.documentElement.classList.add("dark");
        void startSync(value.user.id, value.csrfToken);
      })
      .catch(() => setSession(null));
    return () => { void stopSync(); };
  }, []);

  const authenticated = (value: Session) => {
    setSession(value);
    api.setCsrf(value.csrfToken);
    void startSync(value.user.id, value.csrfToken);
  };
  const logout = async () => {
    await api.request("/api/auth/logout", { method: "POST" });
    await stopSync();
    setSession(null);
  };
  if (session === undefined) return <main class="loading" aria-label="Loading">todorant</main>;
  return session ? <Workspace session={session} logout={() => void logout()} /> : <Landing onAuthenticated={authenticated} />;
}
