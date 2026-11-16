import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Sparkles, Send, X, Loader2, ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import { api, currentTraceId } from '../lib/aimapperApi';
import { getGenieSession, subscribeGenieSession } from '../lib/genieSession';

/* Palette — theme tokens so the panel follows light/dark (see index.css). */
const C = {
  blue: 'var(--brand-strong)',
  blueHover: 'var(--brand)',
  text: 'var(--foreground)',
  muted: 'var(--muted-foreground)',
  border: 'var(--border)',
  borderStrong: 'var(--input)',
  surface: 'var(--card)',
  subtle: 'var(--surface-sunken)',
  userBubble: 'var(--ink)',
  userText: 'var(--ink-foreground)',
  codeBg: 'var(--surface-sunken)',
  disabled: 'var(--muted)',
  ink: 'var(--ink)',
  brand: 'var(--brand)',
};

interface ChatMessage {
  id: number;
  role: 'user' | 'genie';
  text: string;
  sql?: string;
  columns?: string[];
  rows?: string[][];
  suggestedQuestions?: string[];
  status?: string; // thinking | <genie status> | completed | error
}

interface Scope { targetTable?: string; domain?: string; projectId?: string; traceId?: string }

const POLL_INTERVAL = 2000;
const MAX_POLLS = 90; // ~3 minutes
const lit = (v: string) => v.replace(/'/g, '');

/**
 * Hidden context sent with every question. App how-to questions are always
 * answered; mapping-data questions are restricted to the current session.
 */
function sessionPrompt(question: string, s: Scope): string {
  const lines = [
    '[Session context]',
    '- Questions about how the AI Mapper app works (pages, workflow steps, concepts, settings, how-to) are always allowed: answer them from the app guidance.',
  ];
  if (s.targetTable) {
    lines.push(
      '- Questions about mapping data (runs, discovery, retrieval, generation, validation, tokens, timing, examples, feedback) must be answered ONLY for the current session, filtered as below:', // reconstructed: tail after "for th"
      '  - created_by = current_user(),',
      `  - target_table = '${lit(s.targetTable)}'`,
    );
    if (s.domain) lines.push(`  - source system: domain = '${lit(s.domain)}'`);
    if (s.projectId) lines.push(`  - project: project_id = '${lit(s.projectId)}'`);
    if (s.traceId) {
      lines.push(
        `  - aimapper_run_steps: filter on trace_id = '${lit(s.traceId)}' only (some steps have NULL domain/project_id).`,
        '  - Answer questions about discovery, retrieval, generation, validation, tokens or timing from aimapper_run_steps (step and details columns),',
        ' - Use aimapper_conversion_runs only for questions about the saved run (approval, version, saved SQL), and only rows whose item_id appears in the session.', // reconstructed: tail after "appears in"
      );
    } else {
      lines.push('  - No steps are recorded in this browser session yet: use the most recent trace_id / run for this target and user, and say so.');
    }
  } else {
    lines.push(
      '- No mapping session is open. For mapping-data questions, do not query other runs: say there is no current mapping session and that the user can open the Mapper page to start one.', // reconstructed: tail after "can ope"
    );
  }
  lines.push('[End session context]', '', question);
  return lines.join('\n');
}

function starterQuestions(target?: string): string[] {
  if (target) {
    return [
      'Which source tables were searched and skipped during discovery?',
      'Which reference examples were used to generate the SQL?',
      'Did validation pass, and which columns had issues?',
      'How many tokens and how long did each step take?',
    ];
  }
  return [
    'How does the mapping workflow work?',
    'What is a schema version?',
    'How do approvals work?',
    'What does Cross-Project Learning do?',
  ];
}

/* — minimal, safe markdown (bold, inline code, bullet lists, paragraphs) — */
function inline(text: string, key: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g).filter(Boolean).map((p, i) => {
    const k = `${key}-${i}`;
    if (p.length > 4 && p.startsWith('**') && p.endsWith('**')) return <strong key={k} style={{ fontWeight: 600 }}>{p.slice(2, -2)}</strong>;
    if (p.length > 2 && p.startsWith('`') && p.endsWith('`')) {
      return <code key={k} style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.92em', background: C.codeBg, border: `1px solid ${C.border}`, borderRadius: 4, padding: '0 4px' }}>{p.slice(1, -1)}</code>; // reconstructed: style tail after "1px so"
    }
    return <span key={k}>{p}</span>;
  });
}

function Markdown({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let items: ReactNode[] = [];
  const flush = () => {
    if (items.length) {
      out.push(<ul key={`ul-${out.length}`} style={{ margin: '4px 0', paddingLeft: 18, listStyle: 'disc' }}>{items}</ul>);
      items = [];
    }
  };
  text.split('\n').forEach((line, i) => {
    const m = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
    if (m) { items.push(<li key={i} style={{ margin: '2px 0' }}>{inline(m[1], `li${i}`)}</li>); return; }
    flush();
    if (line.trim()) out.push(<p key={i} style={{ margin: '4px 0' }}>{inline(line, `p${i}`)}</p>);
  });
  flush();
  return <>{out}</>;
}

function GenieAvatar({ size = 24 }: { size?: number }) {
  return (
    <div style={{ width: size, height: size, borderRadius: '50%', background: C.ink, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{/* reconstructed: style tail after "justifyContent: 'center'," */}
      <Sparkles size={Math.round(size * 0.55)} color={C.brand} />
    </div>
  );
}

/* — component — */
export function GenieAssistant() {
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [showSql, setShowSql] = useState<Set<number>>(new Set());
  const [showData, setShowData] = useState<Set<number>>(new Set());
  const session = useSyncExternalStore(subscribeGenieSession, getGenieSession);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const msgSeq = useRef(0);
  const scopeKeyRef = useRef('');
  const runRef = useRef(0); // bumps on reset so in-flight polls stop updating

  useEffect(() => {
    api.genieConfig().then((r) => setEnabled(r.enabled)).catch(() => setEnabled(false));
  }, []);

  const reset = useCallback(() => {
    runRef.current++;
    setMessages([]);
    setConversationId(null);
    setLoading(false);
    setShowSql(new Set());
    setShowData(new Set());
    scopeKeyRef.current = '';
  }, []);

  // A different target / source system / project is a different session.
  useEffect(() => { reset(); }, [session.targetTable, session.domain, session.projectId, reset]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, open]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const ask = useCallback(async (raw: string) => {
    const question = raw.trim();
    if (!question || loading) return;
    const run = runRef.current;
    setInput('');
    setLoading(true);

    const traceId = session.targetTable ? currentTraceId(session.targetTable) : undefined;
    const scopeKey = [session.targetTable ?? '', session.domain ?? '', session.projectId ?? '', traceId ?? ''].join('|');
    let cid: string | undefined = conversationId ?? undefined;
    if (scopeKeyRef.current !== scopeKey) {
      if (conversationId) {
        setMessages([{ id: ++msgSeq.current, role: 'genie', text: 'A new mapping run was detected, so I started a new conversation for it.', status: 'completed' }]);
        setConversationId(null);
      }
      cid = undefined;
      scopeKeyRef.current = scopeKey;
    }

    const userId = ++msgSeq.current;
    const genieId = ++msgSeq.current;
    setMessages((prev) => [...prev, { id: userId, role: 'user', text: question }, { id: genieId, role: 'genie', text: '', status: 'thinking' }]);
    const patch = (m: Partial<ChatMessage>) => {
      if (runRef.current !== run) return;
      setMessages((prev) => prev.map((x) => (x.id === genieId ? { ...x, ...m } : x)));
    };

    try {
      const started = await api.genieAsk(sessionPrompt(question, { ...session, traceId }), cid);
      if (runRef.current !== run) return;
      setConversationId(started.conversationId);
      for (let i = 0; i < MAX_POLLS; i++) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL));
        if (runRef.current !== run) return;
        const poll = await api.geniePoll(started.conversationId, started.messageId);
        if (poll.status === 'COMPLETED') {
          let columns: string[] | undefined;
          let rows: string[][] | undefined;
          if (poll.attachmentId && poll.sql) {
            try {
              const qr = await api.genieQueryResult(started.conversationId, started.messageId, poll.attachmentId);
              columns = qr.columns;
              rows = qr.rows;
            } catch { /* best-effort */ }
          }
          patch({ text: poll.answer || 'No answer returned.', sql: poll.sql || undefined, columns, rows, suggestedQuestions: poll.suggestedQuestions, status: 'completed' });
          return;
        }
        if (poll.status === 'FAILED' || poll.status === 'CANCELLED' || poll.status === 'CANCELED') {
          patch({ text: poll.answer || 'Genie could not answer this question. Try rephrasing it.', status: 'error' });
          return;
        }
        patch({ status: poll.status });
      }
      patch({ text: 'Genie is taking too long to respond. Please try again.', status: 'error' });
    } catch (e) {
      patch({ text: String(e instanceof Error ? e.message : e), status: 'error' });
    } finally {
      if (runRef.current === run) setLoading(false);
    }
  }, [loading, conversationId, session]);

  if (!enabled) return null;

  const toggle = (set: Set<number>, id: number) => { const s = new Set(set); if (s.has(id)) s.delete(id); else s.add(id); return s; };
  const last = messages[messages.length - 1];
  const chips = messages.length === 0 ? starterQuestions(session.targetTable) : (last?.role === 'genie' && last.status === 'completed' ? (last.suggestedQuestions ?? []) : []); // reconstructed: tail after "last.suggestedQue"
  const statusLabel = (s?: string) => (!s || s === 'thinking' || s === 'SUBMITTED' ? 'Thinking' : s === 'EXECUTING_QUERY' ? 'Running query' : s === 'FILTERING_CONTEXT' ? 'Narrowing context' : s === 'FETCHING_METADATA' ? 'Reading tables' : s === 'PENDING_WAREHOUSE' ? 'Waiting for warehouse' : s === 'ASKING_AI' ? 'Thinking' : 'Working'); // reconstructed: mapping after "FILTER"
  const scopeLabel = session.targetTable
    ? `Session: ${session.targetTable}${session.domain ? ` · ${session.domain}` : ''}`
    : 'App help · no mapping open';

  return (
    <>
      <style>{`
        @keyframes ga-pop { from { opacity: 0; transform: translateY(12px) scale(.98); } to { opacity: 1; transform: none; } }
        @keyframes ga-pulse { 0%,100% { opacity: .45; } 50% { opacity: 1; } }
        .ga-fab { transition: transform .15s ease, box-shadow .15s ease; }
        .ga-fab:hover { transform: translateY(-2px); box-shadow: 0 12px 30px rgba(15,28,34,.38); }
        .ga-chip:hover { background: ${C.subtle}; border-color: ${C.brand}; }
        .ga-icon-btn:hover { background: var(--ink-2); color: var(--ink-foreground) !important; }
        .ga-link:hover { color: ${C.blueHover}; text-decoration: underline; }
        .ga-input:focus-within { border-color: ${C.brand}; box-shadow: 0 0 0 3px color-mix(in oklab, var(--brand) 18%, transparent); }
        .ga-send:not(:disabled):hover { background: ${C.blueHover} !important; }
        .ga-thinking { animation: ga-pulse 1.4s ease-in-out infinite; }
        .ga-textarea::placeholder { color: ${C.muted}; }
        .ga-textarea:focus, .ga-textarea:focus-visible { outline: none !important; box-shadow: none !important; }
        @media (prefers-reduced-motion: reduce) { .ga-panel, .ga-thinking { animation: none !important; } }
      `}</style>

      {open && (
        <div
          className="ga-panel"
          role="dialog"
          aria-label="Ask Genie"
          style={{
            position: 'fixed', right: 24, bottom: 92, zIndex: 60,
            width: 'min(420px, calc(100vw - 32px))', height: 'min(640px, calc(100vh - 120px))',
            display: 'flex', flexDirection: 'column', background: C.surface, color: C.text,
            border: `1px solid ${C.border}`, borderRadius: 16, boxShadow: '0 18px 50px rgba(15,28,34,.22)',
            overflow: 'hidden', animation: 'ga-pop .18s ease-out', fontSize: 13.5,
          }}
        >
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 12px 12px 16px', background: C.ink, color: C.userText }}>
            <GenieAvatar size={28} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: C.userText }}>Ask Genie</div>
              <div style={{ fontSize: 12, color: 'var(--ink-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={scopeLabel}>{scopeLabel}</div>
            </div>
            <button type="button" className="ga-icon-btn" onClick={reset} title="New chat" style={{ border: 'none', background: 'transparent', borderRadius: 8, width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--ink-muted)' }}>{/* reconstructed: style tail */}
              <RotateCcw size={16} />
            </button>
            <button type="button" className="ga-icon-btn" onClick={() => setOpen(false)} title="Close" style={{ border: 'none', background: 'transparent', borderRadius: 8, width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--ink-muted)' }}>{/* reconstructed: style tail */}
              <X size={16} />
            </button>
          </div>

          {/* Conversation */}
          <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
            {messages.length === 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 10, padding: '24px 8px 8px' }}>
                <GenieAvatar size={40} />
                <div style={{ fontWeight: 600, fontSize: 16, color: C.text }}>How can I help?</div>
                <div style={{ color: C.muted, fontSize: 13, lineHeight: 1.5, maxWidth: 320 }}>
                  Ask anything about how AI Mapper works.
                  {/* reconstructed: text after "</strong>" (tail was cut off) */}
                  {session.targetTable
                    ? <> Questions about mapping data cover only your current <strong style={{ color: C.text, fontWeight: 600 }}>{session.targetTable}</strong>.</>
                    : <> To ask about a mapping, open the Mapper and select a target entity.</>}
                </div>
              </div>
            )}

            {messages.map((m) => m.role === 'user' ? (
              <div key={m.id} style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <div style={{ background: C.userBubble, color: C.userText, padding: '8px 12px', borderRadius: '14px 14px 4px 14px', maxWidth: '85%', lineHeight: 1.5 }}>{/* reconstructed: lineHeight tail */}
                  {m.text}
                </div>
              </div>
            ) : (
              <div key={m.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <GenieAvatar />
                <div style={{ flex: 1, minWidth: 0, lineHeight: 1.55, color: m.status === 'error' ? 'var(--danger-soft-foreground)' : C.text, paddingTop: 2 }}>
                  {m.status !== 'completed' && m.status !== 'error' ? (
                    <span className="ga-thinking" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: C.muted }}>
                      <Loader2 size={14} className="animate-spin" /> {statusLabel(m.status)}…
                    </span>
                  ) : (
                    <Markdown text={m.text} />
                  )}

                  {(m.sql || (m.columns && m.rows && m.rows.length > 0)) && (
                    <div style={{ display: 'flex', gap: 14, marginTop: 6 }}>
                      {m.columns && m.rows && m.rows.length > 0 && (
                        <button type="button" className="ga-link" onClick={() => setShowData((s) => toggle(s, m.id))} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: C.blue, fontSize: 12.5 }}>{/* reconstructed: style tail */}
                          {showData.has(m.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {showData.has(m.id) ? 'Hide' : 'Show'} table ({m.rows.length} rows)
                        </button>
                      )}
                      {m.sql && (
                        <button type="button" className="ga-link" onClick={() => setShowSql((s) => toggle(s, m.id))} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: C.blue, fontSize: 12.5 }}>{/* reconstructed: style tail */}
                          {showSql.has(m.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {showSql.has(m.id) ? 'Hide' : 'Show'} code
                        </button>
                      )}
                    </div>
                  )}

                  {m.columns && m.rows && showData.has(m.id) && (
                    <div style={{ marginTop: 8, overflow: 'auto', maxHeight: 260, border: `1px solid ${C.border}`, borderRadius: 8 }}>
                      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
                        <thead>
                          <tr>{m.columns.map((c, ci) => (
                            <th key={ci} style={{ position: 'sticky', top: 0, background: C.subtle, color: C.text, textAlign: 'left', fontWeight: 600, padding: '5px 10px', borderBottom: `1px solid ${C.disabled}`, whiteSpace: 'nowrap' }}>{c}</th>
                          ))}</tr>
                        </thead>
                        <tbody>
                          {m.rows.slice(0, 100).map((row, ri) => (
                            <tr key={ri}>{row.map((cell, ci) => (
                              // reconstructed: td style tail and NULL rendering (cut off in screenshot)
                              <td key={ci} style={{ padding: '5px 10px', borderBottom: `1px solid ${C.disabled}`, whiteSpace: 'nowrap', color: cell == null ? C.muted : C.text, fontStyle: cell == null ? 'italic' : 'normal' }}>{cell ?? 'NULL'}</td>
                            ))}</tr>
                          ))}
                        </tbody>
                      </table>
                      {m.rows.length > 100 && <div style={{ padding: '6px 10px', color: C.muted, fontSize: 11.5 }}>Showing first 100 of {m.rows.length} rows</div>}{/* reconstructed: "rows" tail */}
                    </div>
                  )}

                  {m.sql && showSql.has(m.id) && (
                    // reconstructed: pre style tail after "fontSize: 11." (cut off in screenshot)
                    <pre style={{ marginTop: 8, padding: '10px 12px', background: C.codeBg, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 11.5, whiteSpace: 'pre-wrap', overflowX: 'auto' }}>{m.sql}</pre>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Suggestions */}
          {chips.length > 0 && !loading && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6, padding: '0 16px 10px' }}>
              {chips.map((q) => (
                <button key={q} type="button" className="ga-chip" onClick={() => void ask(q)} style={{ textAlign: 'left', fontSize: 12.5, lineHeight: 1.4, padding: '6px 10px', borderRadius: 999, border: `1px solid ${C.border}`, background: C.surface, color: C.text, cursor: 'pointer' }}>{/* reconstructed: style tail */}
                  {q}
                </button>
              ))}
            </div>
          )}

          {/* Composer */}
          <div style={{ padding: '10px 12px 8px', borderTop: `1px solid ${C.border}`, background: C.surface }}>
            <form
              className="ga-input"
              onSubmit={(e) => { e.preventDefault(); void ask(input); }}
              style={{ display: 'flex', alignItems: 'flex-end', gap: 8, border: `1px solid ${C.borderStrong}`, borderRadius: 12, padding: '8px 8px 8px 12px' }}
            >
              <textarea
                ref={inputRef}
                className="ga-textarea"
                value={input}
                rows={1}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask(input); } }}
                placeholder={session.targetTable ? `Ask about this ${session.targetTable} mapping or the app…` : 'Ask a question about AI Mapper…'}
                disabled={loading}
                style={{ flex: 1, resize: 'none', border: 'none', outline: 'none', background: 'transparent', color: C.text, fontSize: 13.5, lineHeight: '20px', padding: '6px 0', fontFamily: 'inherit' }}
              />{/* reconstructed: style tail after "lineHeight: '2" */}
              <button
                type="submit"
                className="ga-send"
                disabled={loading || !input.trim()}
                title="Send"
                style={{ width: 32, height: 32, borderRadius: 8, border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, background: loading || !input.trim() ? C.disabled : C.blue, color: loading || !input.trim() ? C.muted : '#fff', cursor: 'pointer' }}
              >{/* reconstructed: style tail after "flexShrin" */}
                {loading ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
              </button>
            </form>
            <div style={{ fontSize: 11, color: C.muted, textAlign: 'center', marginTop: 6 }}>Genie can make mistakes. Review the code behind its answers.</div>{/* reconstructed: tail after "answers.</" */}
          </div>
        </div>
      )}

      {/* Floating action button */}
      <button
        type="button"
        className="ga-fab"
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? 'Close Genie' : 'Ask Genie'}
        title={open ? 'Close Genie' : 'Ask Genie'}
        style={{
          position: 'fixed', right: 24, bottom: 24, zIndex: 60, height: 52, minWidth: 52,
          padding: open ? 0 : '0 18px 0 16px', borderRadius: 26, border: 'none', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          background: C.ink, color: 'var(--ink-foreground)', fontWeight: 700, fontSize: 14.5,
          boxShadow: '0 8px 24px rgba(15,28,34,.30)', fontFamily: 'inherit',
        }}
      >
        {open ? <X size={20} /> : <><Sparkles size={18} color={C.brand} /> Ask Genie</>}
      </button>
    </>
  );
}
