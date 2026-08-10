import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { canonicalRules, type Conflict, type Task } from "@todorant/domain";
import {
  api,
  conflicts,
  connection,
  orderedTasks,
  pendingCount,
  pull,
  queueCommand,
  resolveConflict,
  startSync,
  stopSync
} from "./sync.js";

type Session = {
  user: { id: string; email: string };
  csrfToken: string;
  settings: Record<string, unknown>;
};

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
      onAuthenticated({ ...session, settings: {} });
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

const today = () => new Date().toISOString().slice(0, 10);

function TaskRow({
  task,
  index,
  all,
  current,
  expanded,
  onExpand
}: {
  task: Task;
  index: number;
  all: Task[];
  current: boolean;
  expanded: boolean;
  onExpand: () => void;
}) {
  const [text, setText] = useState(task.text);
  useEffect(() => setText(task.text), [task.text]);

  const saveText = () => {
    const value = text.trim();
    if (value && value !== task.text) void queueCommand(task.id, "update", { text: value });
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

  return (
    <li class={`task ${task.completedAt ? "is-complete" : ""} ${current ? "is-current" : ""}`}>
      <div class="task-main">
        <button
          class="check"
          aria-label={task.completedAt ? `Reopen ${task.text}` : `Complete ${task.text}`}
          aria-pressed={task.completedAt !== null}
          onClick={() => void queueCommand(task.id, task.completedAt ? "reopen" : "complete")}
        >
          {task.completedAt ? "✓" : ""}
        </button>
        <input
          class="task-title"
          value={text}
          aria-label="Task title"
          onInput={(event) => setText(event.currentTarget.value)}
          onBlur={saveText}
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
        {task.schedule.date && <time class="date" dateTime={task.schedule.date}>{task.schedule.date}</time>}
        <button class="icon-button" aria-label={`Details for ${task.text}`} aria-expanded={expanded} onClick={onExpand}>•••</button>
      </div>
      {expanded && (
        <div class="task-details">
          <label class="wide">
            Note
            <textarea
              value={task.note}
              rows={2}
              onBlur={(event) => {
                if (event.currentTarget.value !== task.note) void queueCommand(task.id, "update", { note: event.currentTarget.value });
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
                  schedule: { ...task.schedule, date: event.currentTarget.value || null }
                })
              }
            />
          </label>
          <label>
            Repeat
            <select
              value={task.repeat?.cadence ?? "none"}
              onInput={(event) => {
                const cadence = event.currentTarget.value;
                void queueCommand(task.id, "update", {
                  repeat: cadence === "none" ? null : { cadence: cadence as "daily" | "weekly" | "monthly", interval: 1 }
                });
              }}
            >
              <option value="none">Never</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </label>
          <label>
            Tags / epic
            <input defaultValue={task.tags.join(", ")} onBlur={(event) => setTags(event.currentTarget.value)} />
          </label>
          <div class="detail-actions wide">
            <button onClick={() => void queueCommand(task.id, "update", { frog: !task.frog })}>{task.frog ? "Unmark frog" : "Mark frog"}</button>
            <button onClick={() => void queueCommand(task.id, "skip", {}, { skipDate: task.schedule.date ?? today() })}>Skip occurrence</button>
            <button aria-label="Move task up" disabled={index === 0} onClick={() => move(-1)}>↑</button>
            <button aria-label="Move task down" disabled={index === all.length - 1} onClick={() => move(1)}>↓</button>
            <button class="danger" onClick={() => void queueCommand(task.id, "delete")}>Delete</button>
          </div>
          <p class="meta wide">Revision {task.revision} · Owner {task.ownerId.slice(0, 8)} · {task.encryption ? `Encrypted (${task.encryption.algorithm})` : "Encryption ready"}</p>
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

function SettingsPanel({ session, close }: { session: Session; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [run, setRun] = useState<ImportRun | null>(null);
  useEffect(() => {
    dialog.current?.showModal();
    void api.request<{ run: ImportRun | null }>("/api/import").then((result) => setRun(result.run));
  }, []);
  const setTheme = async (theme: string) => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    await api.request("/api/settings", { method: "PATCH", body: JSON.stringify({ theme }) });
  };
  const beginImport = async () => {
    const created = await api.request<ImportRun>("/api/import", { method: "POST" });
    setRun(created);
    const poll = window.setInterval(() => {
      void api.request<{ run: ImportRun | null }>("/api/import").then((result) => {
        setRun(result.run);
        if (result.run?.status === "complete" || result.run?.status === "failed") {
          window.clearInterval(poll);
          void pull();
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
        <select value={String(session.settings.theme ?? "system")} onInput={(event) => void setTheme(event.currentTarget.value)}>
          <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
        </select>
      </label>
      <section class="settings-section">
        <h3>Data</h3>
        <div class="stack-actions">
          <a class="secondary button-link" href="/api/export" download>Export my data</a>
          <button class="secondary" disabled={run?.status === "queued" || run?.status === "running"} onClick={() => void beginImport()}>Import from Todorant</button>
        </div>
        {run && <p class="import-status" role="status">Import {run.status}{run.status === "complete" ? ` · ${Object.values(run.counts).reduce((sum, count) => sum + count, 0)} records` : ""}{run.errors[0] ? ` · ${run.errors[0]}` : ""}</p>}
      </section>
    </dialog>
  );
}

function Workspace({ session, logout }: { session: Session; logout: () => void }) {
  const [filter, setFilter] = useState<"today" | "planning" | "all" | "trash">("today");
  const [rulesOpen, setRulesOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const list = useMemo(() => {
    const visible = orderedTasks.value.filter((task) => (filter === "trash" ? task.deletedAt : !task.deletedAt));
    if (filter === "today") {
      return visible
        .filter((task) => !task.schedule.date || task.schedule.date <= today())
        .sort((a, b) => Number(b.frog) - Number(a.frog) || Number(Boolean(a.completedAt)) - Number(Boolean(b.completedAt)));
    }
    if (filter === "planning") return visible.filter((task) => task.schedule.date);
    return visible;
  }, [orderedTasks.value, filter]);

  const create = (event: Event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const input = form.elements.namedItem("task") as HTMLInputElement;
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    void queueCommand(crypto.randomUUID(), "create", { text });
  };

  return (
    <div class="shell">
      <header class="topbar">
        <button class="wordmark wordmark-button" onClick={() => setFilter("today")}>todorant</button>
        <nav aria-label="Task views">
          {(["today", "planning", "all", "trash"] as const).map((view) => (
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
        {filter !== "trash" && (
          <form class="quick-add" onSubmit={create}>
            <input name="task" aria-label="New task" placeholder="Add a task and press Enter" autocomplete="off" />
            <button class="primary" type="submit">Add</button>
          </form>
        )}
        <ConflictPanel items={conflicts.value} />
        {list.length ? (
          <ul class="task-list">
            {list.map((task, index) =>
              filter === "trash" ? (
                <li class="task trash-row" key={task.id}><span>{task.text}</span><button onClick={() => void queueCommand(task.id, "restore")}>Restore</button></li>
              ) : (
                <TaskRow key={task.id} task={task} index={index} all={list} current={filter === "today" && index === 0 && !task.completedAt} expanded={expanded === task.id} onExpand={() => setExpanded(expanded === task.id ? null : task.id)} />
              )
            )}
          </ul>
        ) : (
          <p class="empty">Nothing here. Your list has room to breathe.</p>
        )}
      </main>
      <footer><span>Local-first · revisioned history</span><button class="quiet" onClick={logout}>Log out</button></footer>
      {rulesOpen && <RulesPanel close={() => setRulesOpen(false)} />}
      {settingsOpen && <SettingsPanel session={session} close={() => setSettingsOpen(false)} />}
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
