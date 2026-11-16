import { useEffect, useState } from 'react';
import { CheckCircle2, AlertCircle, X } from 'lucide-react';
import { subscribeTasks, dismissTask, type ActivityTask } from '../lib/requestActivity';

// App-wide tray of labelled LONG operations (mapping, SQL generation, uploads,
// re-syncs). Rendered once in the app shell, so it works on every page and keeps
// showing a task even if the user navigates away while it runs.
//
// One centered tray (centered both horizontally and vertically on the content
// area, right of the sidebar on desktop) with a generic animated loader per running task. No time
// estimates or elapsed timers — just what is happening and a simple "working" cue.

/** Generic loading animation: three brand-red dots pulsing in sequence. */
function LoadingDots() {
  return (
    <span className="sm-dots inline-flex items-center gap-1" aria-hidden>
      <span className="h-2 w-2 rounded-full bg-brand" />
      <span className="h-2 w-2 rounded-full bg-brand" />
      <span className="h-2 w-2 rounded-full bg-brand" />
    </span>
  );
}

function TaskRow({ task }: { task: ActivityTask }) {
  const running = task.status === 'running';
  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      <div className="flex w-10 shrink-0 justify-center">
        {running && <LoadingDots />}
        {task.status === 'done' && <CheckCircle2 className="h-5 w-5 text-success" aria-hidden />}
        {task.status === 'error' && <AlertCircle className="h-5 w-5 text-destructive" aria-hidden />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold truncate" title={task.label}>{task.label}</p>
        {running && <p className="text-xs text-ink-muted">Working…</p>}
        {task.status === 'done' && <p className="text-xs text-ink-muted">Done</p>}
        {task.status === 'error' && (
          <p className="text-xs text-brand line-clamp-2" title={task.error}>{task.error || 'Failed'}</p>
        )}
      </div>
      {!running && (
        <button
          type="button"
          onClick={() => dismissTask(task.id)}
          className="shrink-0 rounded-md p-1 text-ink-muted hover:bg-ink-2 hover:text-ink-foreground"
          aria-label="Dismiss"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

export function ActivityTray() {
  const [tasks, setTasks] = useState<ActivityTask[]>([]);
  useEffect(() => subscribeTasks(setTasks), []);

  return (
    <>
      <style>{`
        @keyframes sm-dot-pulse { 0%, 80%, 100% { transform: scale(.6); opacity: .35; } 40% { transform: scale(1); opacity: 1; } }
        .sm-dots > span { animation: sm-dot-pulse 1.2s ease-in-out infinite; }
        .sm-dots > span:nth-child(2) { animation-delay: .15s; }
        .sm-dots > span:nth-child(3) { animation-delay: .3s; }
        @media (prefers-reduced-motion: reduce) { .sm-dots > span { animation: none; opacity: .7; } }
      `}</style>
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed top-1/2 left-1/2 md:left-[calc(50%+8.125rem)] -translate-x-1/2 -translate-y-1/2 z-50 w-[min(28rem,calc(100vw-2rem))]"
        // reconstructed: className tail after "w-[min(28rem,calc(100vw-2rem))" assumed to be "]" (cut off in screenshot)
      >
        {tasks.length > 0 && (
          // Ink surface (matches the sidebar / Genie header), 16px radius, soft shadow.
          <div className="pointer-events-auto rounded-2xl bg-ink text-ink-foreground shadow-[0_18px_50px_rgba(15,28,34,0.35)] overflow-hidden divide-y divide-white/10">{/* reconstructed: "divide-y" tail assumed */}
            {tasks.map((t) => (
              <TaskRow key={t.id} task={t} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
