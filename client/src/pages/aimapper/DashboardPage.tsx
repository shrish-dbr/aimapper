import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Skeleton, Alert, AlertTitle, AlertDescription, Button } from '@databricks/appkit-ui/react';
import { SearchableSelect } from './SearchableSelect';
import { XCircle, ArrowRight, BarChart3 } from 'lucide-react';
import { api, type DashboardStats, type Project } from '../../lib/aimapperApi';
import { PageHeader, Panel, PanelHeader, StatCard, StatusPill, Chip, Mono, Meter, EmptyState } from '../../components/studio';
import { statusTone, statusLabel, type Tone } from '../../lib/display';

// Cache the unfiltered (all-projects) view so navigating back paints instantly.
let statsCache: DashboardStats | null = null;
const ALL = '__all__';

const SEG_BG: Record<Tone, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-brand',
  brand: 'bg-brand',
  neutral: 'bg-muted-foreground/40',
  ink: 'bg-ink',
};

/** Segmented proportion bar + legend (approval status, run outcomes). */
function SegmentLegend({ items }: { items: { label: string; value: number; tone: Tone }[] }) {
  const total = items.reduce((a, b) => a + b.value, 0);
  return (
    <div className="space-y-3">
      <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-muted">
        {items.filter((i) => i.value > 0).map((i) => (
          <div key={i.label} className={`${SEG_BG[i.tone]} h-full first:rounded-l-full last:rounded-r-full`} style={{ width: `${(i.value / Math.max(total, 1)) * 100}%` }} title={`${i.label}: ${i.value}`} />
        ))}
      </div>
      <ul className="space-y-1.5">
        {items.map((i) => (
          <li key={i.label} className="flex items-center justify-between text-sm">
            <span className="inline-flex items-center gap-2"><span className={`h-2.5 w-2.5 rounded-sm ${SEG_BG[i.tone]}`} />{i.label}</span>
            <span className="font-bold tabular-nums">{i.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A lightweight, theme-aware stacked bar of daily token usage (input vs output). */
function StackedTokenBars({ data }: { data: { date: string; prompt: number; completion: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.prompt + d.completion));
  return (
    <div>
      <div className="flex items-end gap-1 h-52 border-b border-border">
        {data.map((d) => {
          const total = d.prompt + d.completion;
          const denom = Math.max(total, 1);
          return (
            <div
              key={d.date}
              className="group flex-1 min-w-0 h-full flex flex-col justify-end"
              title={`${d.date}: ${total.toLocaleString()} tokens — ${d.prompt.toLocaleString()} in / ${d.completion.toLocaleString()} out`}
            >
              <div className="w-full flex flex-col justify-end transition-[height] duration-500 ease-out" style={{ height: `${(total / max) * 100}%` }}>
                <div className="w-full rounded-t-sm bg-brand transition-opacity group-hover:opacity-85" style={{ height: `${(d.completion / denom) * 100}%` }} />
                <div className="w-full bg-ink dark:bg-ink-muted transition-opacity group-hover:opacity-85" style={{ height: `${(d.prompt / denom) * 100}%` }} />
              </div>
            </div>
          );
        })}
      </div>
      {/* Sparse date labels so 30 columns stay legible. */}
      <div className="flex gap-1 mt-1">
        {data.map((d, i) => (
          <span key={d.date} className="flex-1 min-w-0 text-center text-[9px] text-muted-foreground tabular-nums">
            {i % Math.ceil(data.length / 8 || 1) === 0 ? d.date : ''}
          </span>
        ))}
      </div>
      <div className="flex items-center justify-center gap-4 mt-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-ink dark:bg-ink-muted" /> Input (prompt)</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-brand" /> Output (completion)</span>
      </div>
    </div>
  );
}

const pct = (v: number | null | undefined) => (v != null ? `${Math.round(v * 100)}%` : '—');

export function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(statsCache);
  const [loading, setLoading] = useState(statsCache === null);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string>(ALL);
  const navigate = useNavigate();

  // Project options for the filter.
  useEffect(() => {
    api.projects().then((d) => setProjects(d.projects)).catch(() => setProjects([]));
  }, []);

  // (Re)load stats whenever the project scope changes.
  useEffect(() => {
    let active = true;
    const scoped = projectId !== ALL;
    const load = async () => {
      // Skeleton only on a true cold load of the unfiltered view.
      if (!scoped && statsCache === null) setLoading(true);
      else if (scoped) setLoading(true);
      try {
        const s = await api.dashboardStats(scoped ? projectId : undefined);
        if (!scoped) statsCache = s;
        if (active) { setStats(s); setError(null); }
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => { active = false; };
  }, [projectId]);

  const runOutcomes = stats
    ? Object.entries(stats.statusCounts).map(([name, value]) => ({ label: statusLabel(name), value, tone: statusTone(name) }))
    : [];
  const approvalItems = stats
    ? [
        { label: 'In review', value: stats.approval.in_review, tone: 'warning' as Tone },
        { label: 'Approved', value: stats.approval.approved, tone: 'success' as Tone },
        { label: 'Rejected', value: stats.approval.rejected, tone: 'danger' as Tone },
      ]
    : [];
  const approvalTotal = approvalItems.reduce((a, b) => a + b.value, 0);
  const fbTotal = stats ? stats.feedback.up + stats.feedback.down : 0;
  const fbPct = fbTotal ? Math.round((stats!.feedback.up / fbTotal) * 100) : null;
  const successful = stats?.statusCounts.SUCCESS ?? 0;

  return (
    <div className="space-y-6 w-full">
      <PageHeader
        eyebrow="Workspace"
        title="Dashboard"
        description="Mapping coverage and quality across your target schema."
        actions={
          <>
            {/* Project scope filter — narrows every metric below. */}
            <SearchableSelect
              value={projectId}
              onValueChange={setProjectId}
              className="w-56"
              placeholder="All projects"
              options={[{ value: ALL, label: 'All projects' }, ...projects.map((p) => ({ value: p.project_id, label: p.name }))]}
            />
            <Button size="lg" onClick={() => void navigate('/mapper')}>
              Open Mapper <ArrowRight className="h-4 w-4" />
            </Button>
          </>
        }
      />

      {error && (
        <Alert variant="destructive">
          <XCircle className="h-4 w-4" />
          <AlertTitle>Could not load stats</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {loading && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Skeleton className="h-[22rem] w-full rounded-[var(--radius)] lg:row-span-2" />
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[10.5rem] w-full rounded-[var(--radius)]" />)}
        </div>
      )}

      {stats && !loading && (
        <>
          {/* Hero + portfolio tiles. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-[1.25fr_1fr_1fr] gap-4">
            <Panel tone="ink" className="relative overflow-hidden px-7 py-6 sm:col-span-2 lg:col-span-1 lg:row-span-2">
              <span aria-hidden className="pointer-events-none absolute -right-16 -top-16 h-64 w-64 rounded-full border-[28px] border-brand/25" />
              <div className="relative">
                <p className="flex items-center gap-2 text-[0.8125rem] font-semibold uppercase tracking-[0.08em] text-ink-foreground/90">
                  <span className="h-2 w-2 rounded-full bg-brand" /> Target coverage
                </p>
                <p className="mt-5 text-[5rem] leading-none font-bold tracking-tighter tabular-nums">
                  {stats.coveragePct}<span className="text-[2.25rem] text-brand align-baseline">%</span>
                </p>
                <p className="mt-3 text-[0.9375rem] text-ink-foreground/85">
                  {stats.mappedTargets} of {stats.totalTargets} target entities mapped
                </p>
                <div className="mt-6 grid grid-cols-2 gap-x-8 gap-y-6 max-w-xs">
                  <div>
                    <p className="text-2xl font-bold tabular-nums">{stats.mappedColumns} / {stats.totalTargetColumns}</p>
                    <p className="text-[0.8125rem] text-ink-muted">columns mapped</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold tabular-nums">{pct(stats.avgConfidence)}</p>
                    <p className="text-[0.8125rem] text-ink-muted">avg confidence</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold tabular-nums">{stats.totalRuns}</p>
                    <p className="text-[0.8125rem] text-ink-muted">
                      runs · {stats.totalRuns > 0 && successful === stats.totalRuns ? 'all successful' : `${successful} successful`}
                    </p>
                  </div>
                </div>
              </div>
            </Panel>
            <StatCard label="Projects" value={stats.portfolio.projects} hint={projectId === ALL ? 'across all source systems' : 'viewing one project'} />
            <StatCard
              label="Source systems"
              value={stats.portfolio.sourceSystems}
              hint={`EHR system types · ${stats.portfolio.vendors} vendor${stats.portfolio.vendors === 1 ? '' : 's'}`}
            />
            <StatCard label="Awaiting review" value={stats.approval.in_review} hint={`${stats.approval.approved} approved · ${stats.approval.rejected} rejected`} />
            <StatCard label="Unmapped columns" value={stats.unmappedColumns} hint={`of ${stats.totalTargetColumns} target columns`} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-[1fr_23rem] gap-4 items-start">
            {/* Per-target coverage table. */}
            <Panel className="overflow-hidden">
              <PanelHeader
                title="Target coverage"
                description="Latest mapping status and confidence per target entity."
                actions={<span className="text-sm text-muted-foreground tabular-nums">{stats.coveragePct}% covered</span>}
              />
              {stats.perTarget.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-y border-border">
                        <th className="eyebrow px-6 py-3 text-left font-semibold">Entity</th>
                        <th className="eyebrow px-4 py-3 text-left font-semibold w-[40%]">Confidence</th>
                        <th className="eyebrow px-4 py-3 text-left font-semibold">Columns</th>
                        <th className="eyebrow px-6 py-3 text-left font-semibold">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {stats.perTarget.map((t) => (
                        <tr key={t.target_table}>
                          <td className="px-6 py-4"><Mono className="font-semibold">{t.target_table}</Mono></td>
                          <td className="px-4 py-4">
                            <div className="flex items-center gap-4">
                              <Meter value={t.confidence} className="flex-1" />
                              <span className="w-10 text-right font-bold tabular-nums">{t.confidence != null ? pct(t.confidence) : '—'}</span>
                            </div>
                          </td>
                          <td className="px-4 py-4 tabular-nums text-muted-foreground">{t.columns}</td>
                          <td className="px-6 py-4"><StatusPill tone={statusTone(t.status)}>{statusLabel(t.status)}</StatusPill></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="px-6 pb-6 text-sm text-muted-foreground">No targets found. Configure a target-schema table on the Config page.</p>
              )}
            </Panel>

            {/* Right column. */}
            <div className="space-y-4">
              <Panel className="px-6 py-5">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-[1.125rem] font-bold tracking-tight">Approval status</h2>
                  <button type="button" onClick={() => void navigate('/approvals')} className="text-sm font-semibold text-brand-strong underline underline-offset-2 hover:text-brand">
                    Review queue
                  </button>
                </div>
                {approvalTotal > 0 ? <SegmentLegend items={approvalItems} /> : <p className="text-sm text-muted-foreground">Nothing submitted for review yet.</p>}
              </Panel>

              <Panel className="px-6 py-5">
                <h2 className="text-[1.125rem] font-bold tracking-tight mb-4">Run outcomes</h2>
                {runOutcomes.length > 0 ? <SegmentLegend items={runOutcomes} /> : <p className="text-sm text-muted-foreground">No runs yet.</p>}
              </Panel>

              <Panel className="px-6 py-5">
                <h2 className="text-[1.125rem] font-bold tracking-tight">Coverage by source system</h2>
                <p className="text-xs text-muted-foreground mt-0.5 mb-4">Mapped target entities and average confidence per EHR system type.</p>
                {stats.bySourceSystem.length > 0 ? (
                  <div className="space-y-4">
                    {stats.bySourceSystem.map((s) => {
                      const cov = stats.totalTargets ? Math.round((s.mappedTargets / stats.totalTargets) * 100) : 0;
                      return (
                        <div key={s.source_system} className="space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <Chip>{s.source_system}</Chip>
                            <span className="text-[0.8125rem] text-muted-foreground text-right">
                              {s.mappedTargets} of {stats.totalTargets} entities
                              {s.avgConfidence != null && <> · {pct(s.avgConfidence)} avg confidence</>}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <Meter value={cov / 100} tone="ink" className="h-2 flex-1" />
                            <span className="text-xs font-semibold tabular-nums w-9 text-right">{cov}%</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No mappings yet — generate and approve mappings to see per-source-system coverage.</p>
                )}
              </Panel>

              <Panel className="px-6 py-5">
                <h2 className="text-[1.125rem] font-bold tracking-tight mb-3">Top references</h2>
                {stats.topReferences.length > 0 ? (
                  <ul className="space-y-2.5">
                    {stats.topReferences.map((r) => (
                      <li key={r.target_table} className="flex items-center justify-between text-sm">
                        <Mono>{r.target_table}</Mono>
                        <span className="font-bold tabular-nums">{r.count}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">No approved references yet.</p>
                )}
              </Panel>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-[1fr_23rem] gap-4 items-stretch">
            {/* Token usage trend (last 30 days). */}
            <Panel className="px-6 py-5">
              <div className="flex items-start justify-between gap-4 flex-wrap mb-5">
                <div>
                  <h2 className="text-[1.125rem] font-bold tracking-tight">Token usage</h2>
                  <p className="text-sm text-muted-foreground mt-0.5">LLM tokens per day, last 30 days — prompt vs completion.</p>
                </div>
                <div className="text-right">
                  <p className="text-[1.75rem] leading-none font-bold tabular-nums">{stats.tokens.total.toLocaleString()}</p>
                  <p className="text-xs text-muted-foreground mt-1">total · {stats.tokens.last7.toLocaleString()} in last 7 days</p>
                </div>
              </div>
              {stats.tokenTrend.some((d) => d.prompt + d.completion > 0) ? (
                <StackedTokenBars data={stats.tokenTrend} />
              ) : (
                <EmptyState icon={<BarChart3 className="h-5 w-5" />}>No token usage recorded in the last 30 days.</EmptyState>
              )}
            </Panel>

            <Panel className="px-6 py-5">
              <h2 className="text-[1.125rem] font-bold tracking-tight mb-3">Feedback signal</h2>
              {fbTotal > 0 ? (
                <div className="space-y-2">
                  <p className="text-[2rem] leading-none font-bold tabular-nums">
                    {fbPct}%<span className="text-sm font-normal text-muted-foreground ml-1.5">positive</span>
                  </p>
                  <div className="flex items-center gap-3 text-sm text-muted-foreground">
                    <span className="text-success font-semibold">▲ {stats.feedback.up}</span>
                    <span className="text-brand-strong font-semibold">▼ {stats.feedback.down}</span>
                    <span>· {fbTotal} vote{fbTotal === 1 ? '' : 's'}</span>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    No 👍/👎 feedback on mappings yet. Feedback steers future discovery for each target.
                  </p>
                  <button type="button" onClick={() => void navigate('/mapper')} className="text-sm font-semibold text-brand-strong underline underline-offset-2 hover:text-brand">
                    Give feedback in the Mapper
                  </button>
                </div>
              )}
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}
