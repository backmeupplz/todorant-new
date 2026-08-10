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
  currentUserId
}: {
  task: Task;
  index: number;
  all: Task[];
  current: boolean;
  expanded: boolean;
  onExpand: () => void;
  settings: ProductSettings;
  currentUserId: string;
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
      epicId: task.epicId,
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
        epicId: task.epicId,
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
    <li class={`task ${task.completedAt ? "is-complete" : ""} ${current ? "is-current" : ""}`}>
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
          <label>
            Epic
            <input value={task.epicId ?? ""} placeholder="Epic name" onInput={(event) => void queueCommand(task.id, "update", { epicId: event.currentTarget.value || null })} />
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
      <header><div><span class="eyebrow">Todorant</span><h2>Rules</h2></div><button class="icon-button" aria-label="Close rules" onClick={() => dialog.current?.close()}>×</button></header>
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
        <label>Local encryption key<input type="password" minlength={12} value={passphrase} placeholder="Not sent to the server" onInput={(event) => { setPassphrase(event.currentTarget.value); encryptionPassphrase.value = event.currentTarget.value; }} /></label>
        <p class="meta">The key stays in this browser session. Losing it makes encrypted task text unrecoverable.</p>
      </section>
      <section class="settings-section">
        <h3>Data</h3>
        <div class="stack-actions">
          <a class="secondary button-link" href="/api/export" download>Export my data</a>
          <label>Legacy access token<input type="password" autocomplete="off" value={legacyToken} onInput={(event) => setLegacyToken(event.currentTarget.value)} /></label>
          <button class="secondary" disabled={legacyToken.length < 16 || run?.status === "queued" || run?.status === "running"} onClick={() => void beginImport()}>Verify and import from Todorant</button>
        </div>
        {run && <p class="import-status" role="status">Import {run.status}{run.status === "complete" ? ` · ${Object.values(run.counts).reduce((sum, count) => sum + count, 0)} records` : ""}{run.errors[0] ? ` · ${run.errors[0]}` : ""}</p>}
      </section>
    </dialog>
  );
}

type TaskView = "current" | "today" | "planning" | "all" | "epics" | "reports" | "trash";

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

function EpicSummary({ all, settings }: { all: Task[]; settings: Record<string, unknown> }) {
  const [goals, setGoals] = useState<Record<string, number>>(
    settings.epicGoals && typeof settings.epicGoals === "object"
      ? (settings.epicGoals as Record<string, number>)
      : {}
  );
  const epics = new Map<string, { completed: number; total: number }>();
  for (const task of all.filter((item) => item.epicId && !item.deletedAt)) {
    const value = epics.get(task.epicId as string) ?? { completed: 0, total: 0 };
    value.total += 1;
    if (task.completedAt) value.completed += 1;
    epics.set(task.epicId as string, value);
  }
  const setGoal = async (epic: string, goal: number) => {
    const next = { ...goals, [epic]: Math.max(1, goal) };
    setGoals(next);
    await api.request("/api/settings", { method: "PATCH", body: JSON.stringify({ epicGoals: next }) });
  };
  return <section class="report" aria-label="Epic progress"><ul>{[...epics].map(([epic, value]) => <li key={epic}><strong>{epic}</strong><span>{value.completed} / <input aria-label={`Goal for ${epic}`} type="number" min={1} value={goals[epic] ?? value.total} onInput={(event) => void setGoal(epic, Number(event.currentTarget.value))} /> completed</span></li>)}</ul></section>;
}

export function Workspace({ session, logout }: { session: Session; logout: () => void }) {
  const [settings, setSettings] = useState<ProductSettings>(session.settings);
  const [filter, setFilter] = useState<TaskView>("current");
  const [search, setSearch] = useState("");
  const [rulesOpen, setRulesOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [invitations, setInvitations] = useState<DelegationInvite[]>([]);
  const [invitationError, setInvitationError] = useState("");
  const initializedDefaultExpansion = useRef(false);
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
  const list = useMemo(() => {
    const visible = orderedTasks.value.filter((task) => (filter === "trash" ? task.deletedAt : !task.deletedAt));
    const matching = search.trim()
      ? visible.filter((task) => `${task.text} ${task.note} ${task.tags.join(" ")} ${task.epicId ?? ""}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
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
        .filter((task) => isActionableOn(task, date))
        .sort((a, b) => Number(Boolean(a.completedAt)) - Number(Boolean(b.completedAt)) || compareFocusOrder(a, b, enabled(settings, "preserveOrderByTime")));
    }
    if (filter === "planning") {
      return matching
        .filter((task) => !task.completedAt && (task.schedule.month !== null || task.schedule.date !== null))
        .sort((a, b) => {
          const left = a.schedule.date ?? `${a.schedule.month ?? "9999-99"}-99`;
          const right = b.schedule.date ?? `${b.schedule.month ?? "9999-99"}-99`;
          return left.localeCompare(right) || compareRanks(a.rank, b.rank);
        });
    }
    if (filter === "epics") return matching.filter((task) => task.epicId);
    return matching;
  }, [orderedTasks.value, filter, search, planningRequired, date, settings.preserveOrderByTime]);

  const create = async (event: Event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const input = form.elements.namedItem("task") as HTMLInputElement;
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    const selectedDate = (form.elements.namedItem("date") as HTMLInputElement).value || null;
    const selectedTime = (form.elements.namedItem("time") as HTMLInputElement).value || null;
    const nextMonth = new Date(`${date}T12:00:00`);
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    const scheduleDate = selectedDate ?? (enabled(settings, "showTodayOnAddTodo") ? date : null);
    const scheduleMonth = scheduleDate?.slice(0, 7) ?? `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, "0")}`;
    const protectedFields = encryptionPassphrase.value.length >= 12
      ? await encryptTaskFields(text, "", encryptionPassphrase.value)
      : { text };
    await queueCommand(crypto.randomUUID(), "create", {
      ...protectedFields,
      schedule: { month: scheduleMonth, date: scheduleDate, time: selectedTime, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }
    }, enabled(settings, "newTodosGoFirst") ? { ordering: { afterId: null, beforeId: orderedTasks.value[0]?.id ?? null } } : {});
  };

  return (
    <div class="shell">
      <header class="topbar">
        <button class="wordmark wordmark-button" onClick={() => setFilter("today")}>todorant</button>
        <nav aria-label="Task views">
          {(["current", "today", "planning", "all", "epics", "reports", "trash"] as const).map((view) => (
            <button class={filter === view ? "active" : ""} aria-current={filter === view ? "page" : undefined} onClick={() => setFilter(view)}>{view[0]?.toUpperCase()}{view.slice(1)}</button>
          ))}
        </nav>
        <div class="top-actions">
          <span class={`sync ${connection.value}`} title={`${pendingCount.value} queued operations`}>{connection.value}{pendingCount.value ? ` · ${pendingCount.value}` : ""}</span>
          <button onClick={() => setRulesOpen(true)}>Rules</button>
          <button aria-label="Open settings" onClick={() => setSettingsOpen(true)}>⚙</button>
        </div>
      </header>
      <main class="workspace">
        <div class="list-header"><div><span class="eyebrow">{filter === "planning" ? "Calendar" : "Tasks"}</span><h1>{filter[0]?.toUpperCase()}{filter.slice(1)}</h1></div><span class="count">{list.length}</span></div>
        <input class="search" type="search" value={search} placeholder="Search tasks, notes, tags, and epics" aria-label="Search tasks" onInput={(event) => setSearch(event.currentTarget.value)} />
        {filter !== "trash" && (
          <form class="quick-add" onSubmit={(event) => void create(event)}>
            <input name="task" aria-label="New task" placeholder="Add a task and press Enter" autocomplete="off" />
            <input name="date" aria-label="New task date" type="date" defaultValue={enabled(settings, "showTodayOnAddTodo") ? date : ""} />
            <input name="time" aria-label="New task exact time" type="time" />
            <button class="primary" type="submit">Add</button>
          </form>
        )}
        {filter === "planning" && <p class="meta">Weeks start {Number(settings.firstDayOfWeek ?? 1) === 0 ? "Sunday" : Number(settings.firstDayOfWeek ?? 1) === 6 ? "Saturday" : "Monday"} · Todorant day starts {String(settings.startTimeOfDay ?? "00:00")}</p>}
        <ConflictPanel items={conflicts.value} />
        <SyncErrorPanel />
        {invitations.length > 0 && (
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
        {filter === "epics" && <EpicSummary all={orderedTasks.value} settings={session.settings} />}
        {filter === "reports" ? <ReportPanel all={orderedTasks.value} /> : list.length ? (
          <ul class="task-list">
            {list.map((task, index) =>
              filter === "trash" ? (
                <li class="task trash-row" key={task.id}><span>{task.text}</span><button onClick={() => void queueCommand(task.id, "restore")}>Restore</button></li>
              ) : (
                <TaskRow key={task.id} task={task} index={index} all={list} current={filter === "today" && index === 0 && !task.completedAt} expanded={expanded === task.id} onExpand={() => setExpanded(expanded === task.id ? null : task.id)} settings={settings} currentUserId={session.user.id} />
              )
            )}
          </ul>
        ) : (
          <p class="empty">{filter === "current" && planningRequired ? "Redistribute overdue work in Planning to unlock Current." : "Nothing here. Your list has room to breathe."}</p>
        )}
      </main>
      <footer><span>Local-first · revisioned history</span><button class="quiet" onClick={logout}>Log out</button></footer>
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
