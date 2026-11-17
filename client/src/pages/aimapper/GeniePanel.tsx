import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input, Badge, Separator } from '@databricks/appkit-ui/react';
import { MessageCircle, Send, X, Loader2, ChevronDown, ChevronUp, Sparkles, Table2 } from 'lucide-react';
import { api, currentTraceId } from '../../lib/aimapperApi';

/* — types ———————————————————————————————————————————————— */
interface ChatMessage {
  id?: number;
  role: 'user' | 'genie';
  text: string;
  sql?: string;
  columns?: string[];
  rows?: string[][];
  suggestedQuestions?: string[];
  status?: string;
  error?: string;
}

interface GeniePanelProps {
  targetTable?: string;
  domain?: string;
  projectId?: string;
  onClose: () => void;
}

interface SessionScope { targetTable?: string; domain?: string; projectId?: string; traceId?: string }

const lit = (v: string) => v.replace(/'/g, '');

/**
 * Prefix every question with the current mapping session so Genie only answers
 * about what is on screen. The user only sees their own question in the panel.
 */
function sessionPrompt(question: string, s: SessionScope): string {
  const lines = [
    '[Session context: answer ONLY about this mapping session and apply these filters to every query]',
    '- User: created_by = current_user()',
  ];
  if (s.targetTable) lines.push(`- Target: target_table = '${lit(s.targetTable)}'`);
  if (s.domain) lines.push(`- Source system: domain = '${lit(s.domain)}'`);
  if (s.projectId) lines.push(`- Project: project_id = '${lit(s.projectId)}'`);
  if (s.traceId) {
    lines.push(
      `- aimapper_run_steps: filter on trace_id = '${lit(s.traceId)}' only (some steps have NULL domain/project_id).`,
      '- aimapper_conversion_runs: only rows whose item_id appears in those steps; if none are saved yet, say the session has not been saved.',
    );
  } else {
    lines.push('- No steps have been recorded in this browser session yet: use the most recent trace_id / run for this target and user, and say so.');
  }
  lines.push('[End session context]', '', question);
  return lines.join('\n');
}

/* — suggested questions (context-aware) ———————————————————— */
function defaultQuestions(target?: string): string[] {
  if (!target) return [];
  return [
    'Which source tables were searched and skipped during discovery?',
    'Which reference examples were used to generate the SQL?',
    'Did validation pass, and which columns had issues?',
    'How many tokens and how long did each step take?',
  ];
}

const POLL_INTERVAL = 2000;
const MAX_POLLS = 90; // 3 minutes

/* — component ———————————————————————————————————————————— */
export function GeniePanel({ targetTable, domain, projectId, onClose }: GeniePanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [expandedSql, setExpandedSql] = useState<Set<number>>(new Set());
  const [expandedData, setExpandedData] = useState<Set<number>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef(false);
  const msgSeq = useRef(0);
  // Session the current conversation belongs to (target|domain|project|trace).
  const scopeKeyRef = useRef('');

  // Switching target / source system / project starts a fresh conversation.
  useEffect(() => {
    abortRef.current = true;
    setMessages([]);
    setConversationId(null);
    scopeKeyRef.current = '';
  }, [targetTable, domain, projectId]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const askGenie = useCallback(async (question: string) => {
    if (!question.trim() || loading) return;
    abortRef.current = false;
    setInput('');
    setLoading(true);

    // Resolve the session at ask time: the trace changes whenever discovery or
    // generation runs again for this target, and that starts a new conversation.
    const traceId = targetTable ? currentTraceId(targetTable) : undefined;
    const scopeKey = [targetTable ?? '', domain ?? '', projectId ?? '', traceId ?? ''].join('|');
    let cidForRequest = conversationId ?? undefined;
    if (scopeKeyRef.current !== scopeKey) {
      if (conversationId) {
        setMessages([{ id: ++msgSeq.current, role: 'genie', text: 'A new mapping run was detected, so this is a new conversation.', status: 'completed' }]);
        setConversationId(null);
      }
      cidForRequest = undefined;
      scopeKeyRef.current = scopeKey;
    }

    const genieId = ++msgSeq.current;
    setMessages((prev) => [...prev, { id: ++msgSeq.current, role: 'user', text: question }, { id: genieId, role: 'genie', text: '', status: 'thinking' }]);
    const patchGenie = (m: Partial<ChatMessage>) =>
      setMessages((prev) => prev.map((x) => (x.id === genieId ? { ...x, ...m, id: genieId } : x)));

    try {
      const { conversationId: cid, messageId } = await api.genieAsk(
        sessionPrompt(question, { targetTable, domain, projectId, traceId }),
        cidForRequest,
      );
      setConversationId(cid);

      // Poll for result
      let polls = 0;
      let finalResult: ChatMessage | null = null;
      while (polls < MAX_POLLS && !abortRef.current) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL));
        polls++;
        const poll = await api.geniePoll(cid, messageId);

        if (poll.status === 'COMPLETED') {
          // Fetch query result if there's SQL
          let columns: string[] | undefined;
          let rows: string[][] | undefined;
          if (poll.attachmentId && poll.sql) {
            try {
              const qr = await api.genieQueryResult(cid, messageId, poll.attachmentId);
              columns = qr.columns;
              rows = qr.rows;
            } catch { /* query result fetch is best-effort */ }
          }
          finalResult = {
            role: 'genie',
            text: poll.answer || 'No answer returned.',
            sql: poll.sql || undefined,
            columns,
            rows,
            suggestedQuestions: poll.suggestedQuestions,
            status: 'completed',
          };
          break;
        } else if (poll.status === 'FAILED' || poll.status === 'CANCELED') {
          finalResult = {
            role: 'genie',
            text: poll.answer || 'Genie could not answer this question.',
            status: 'error',
            error: poll.status,
          };
          break;
        }
        patchGenie({ status: poll.status.toLowerCase().replace(/_/g, ' ') });
      }

      if (!finalResult && !abortRef.current) {
        finalResult = { role: 'genie', text: 'Timed out waiting for Genie.', status: 'error', error: 'timeout' };
      }

      if (finalResult) patchGenie({ sql: undefined, columns: undefined, rows: undefined, suggestedQuestions: undefined, ...finalResult });
    } catch (e) {
      patchGenie({ text: String(e instanceof Error ? e.message : e), status: 'error', error: 'exception' });
    } finally {
      setLoading(false);
    }
  }, [loading, conversationId, targetTable, domain, projectId]);

  const toggleSql = (idx: number) => setExpandedSql((prev) => {
    const s = new Set(prev); if (s.has(idx)) s.delete(idx); else s.add(idx); return s;
  });
  const toggleData = (idx: number) => setExpandedData((prev) => {
    const s = new Set(prev); if (s.has(idx)) s.delete(idx); else s.add(idx); return s;
  });

  const suggestedQs = messages.length === 0
    ? defaultQuestions(targetTable)
    : (messages[messages.length - 1]?.suggestedQuestions ?? []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', borderLeft: '1px solid var(--border)', background: 'var(--background)' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: 'var(--ink)', color: 'var(--ink-foreground)' }}>{/* reconstructed: style closing cut off at right edge */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <MessageCircle size={16} />
          <span style={{ fontWeight: 700, fontSize: 14 }}>Ask Genie</span>
          {targetTable && <Badge variant="secondary">{targetTable}</Badge>}
        </div>
        <Button variant="ghost" size="sm" className="text-ink-foreground hover:bg-ink-2 hover:text-ink-foreground" onClick={onClose}><X size={14} /></Button>
      </div>

      {/* Messages */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {messages.length === 0 && (
          <div style={{ color: 'var(--muted-foreground)', fontSize: 13, lineHeight: 1.6, padding: '8px 0' }}>
            {targetTable
              ? <>Answers cover only this mapping session: <strong>{targetTable}</strong>{domain ? ` (${domain})` : ''}, your discovery, generation and validation runs are the context.{/* reconstructed: text cut off at right edge */}</>
              : <>Select a target entity to ask about this mapping session.</>}
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
            <div style={{
              padding: '8px 12px', borderRadius: 8, fontSize: 13, lineHeight: 1.5, maxWidth: '90%', whiteSpace: 'pre-wrap',
              ...(m.role === 'user'
                ? { background: 'var(--ink)', color: 'var(--ink-foreground)' }
                : { background: 'var(--surface-sunken)', color: 'var(--foreground)' }),
            }}>
              {m.status === 'thinking' || (m.status && m.status !== 'completed' && m.status !== 'error')
                ? /* reconstructed: inner ternary cut off at right edge */ <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Loader2 size={14} className="animate-spin" /> {m.status === 'thinking' ? 'Thinking…' : m.status}</span>
                : m.text}
            </div>

            {/* SQL toggle */}
            {m.sql && (
              <button onClick={() => toggleSql(i)} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--muted-foreground)', cursor: 'pointer', background: 'none', border: 'none', padding: 0 }}>{/* reconstructed: style cut off at right edge */}
                <Sparkles size={12} /> SQL {expandedSql.has(i) ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              </button>
            )}
            {m.sql && expandedSql.has(i) && (
              /* reconstructed: style cut off at right edge */ <pre style={{ fontSize: 11, padding: '8px 10px', borderRadius: 6, background: 'var(--card)', border: '1px solid var(--border)', overflowX: 'auto', whiteSpace: 'pre-wrap' }}>{m.sql}</pre>
            )}

            {/* Data toggle */}
            {m.columns && m.rows && m.rows.length > 0 && (
              <button onClick={() => toggleData(i)} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--muted-foreground)', cursor: 'pointer', background: 'none', border: 'none', padding: 0 }}>{/* reconstructed: style cut off at right edge */}
                <Table2 size={12} /> {m.rows.length} row{m.rows.length !== 1 ? 's' : ''} {expandedData.has(i) ? <ChevronUp size={12} /> : <ChevronDown size={12} />}{/* reconstructed: label cut off at right edge */}
              </button>
            )}
            {m.columns && m.rows && expandedData.has(i) && (
              <div style={{ overflowX: 'auto', maxWidth: '90%', border: '1px solid var(--border)', borderRadius: 6, fontSize: 11 }}>
                <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                  <thead>
                    <tr>{m.columns.map((c, ci) => <th key={ci} style={{ padding: '4px 8px', textAlign: 'left', borderBottom: '1px solid var(--border)', background: 'var(--card)' }}>{c}</th>)}{/* reconstructed: style cut off at right edge */}</tr>
                  </thead>
                  <tbody>
                    {m.rows.slice(0, 50).map((row, ri) => (
                      <tr key={ri}>{row.map((cell, ci) => <td key={ci} style={{ padding: '3px 8px', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{cell}</td>)}{/* reconstructed: style cut off at right edge */}</tr>
                    ))}
                  </tbody>
                </table>
                {m.rows.length > 50 && <div style={{ padding: '4px 8px', color: 'var(--muted-foreground)', fontSize: 11 }}>Showing first 50 of {m.rows.length} rows</div>}{/* reconstructed: text cut off at right edge */}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Suggested questions */}
      {suggestedQs.length > 0 && !loading && (
        <div style={{ padding: '4px 16px 8px', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {suggestedQs.slice(0, 4).map((q, i) => (
            <button key={i} onClick={() => void askGenie(q)} style={{
              fontSize: 11, padding: '4px 10px', borderRadius: 16, border: '1px solid var(--border)',
              background: 'var(--card)', color: 'var(--foreground)', cursor: 'pointer', whiteSpace: 'nowrap',
              overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%',
            }}>{q}</button>
          ))}
        </div>
      )}

      <Separator />

      {/* Input */}
      <form onSubmit={(e) => { e.preventDefault(); void askGenie(input); }} style={{ display: 'flex', gap: 8, padding: '10px 16px' }}>
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={targetTable ? `Ask about this ${targetTable} mapping...` : 'Select a target first'}
          disabled={loading || !targetTable}
          style={{ flex: 1, fontSize: 13 }}
        />
        <Button type="submit" size="sm" disabled={loading || !input.trim()}>
          <Send size={14} />
        </Button>
      </form>
    </div>
  );
}
