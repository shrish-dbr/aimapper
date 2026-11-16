import { useNavigate } from 'react-router';
import {
  Waypoints, FolderKanban, Network, Building2, Database, Search, Sparkles, CheckCircle2,
  ClipboardCheck, ThumbsUp, ArrowRight, GitBranch, Wand2,
} from 'lucide-react';
import { PageHeader, Panel, PanelHeader } from '../../components/studio';

// The mapping pipeline, end to end.
const STEPS = [
  { icon: FolderKanban, title: 'Pick a Project', body: 'Choose the project you’re mapping in — it sets the source system, vendor, and schema version for everything that follows.' },
  { icon: Search, title: 'Select Source & Target', body: 'Point at a source catalog → schema → tables, choose the target entity, and an LLM endpoint.' },
  { icon: Wand2, title: 'Identify Mappings', body: 'The LLM matches each target column to the best source column across your tables, with a confidence score.' },
  { icon: Sparkles, title: 'Generate SQL', body: 'It writes one JOIN SELECT that shapes the sources into the target contract — grounded by approved examples & docs.' },
  { icon: CheckCircle2, title: 'Validate', body: 'A dry run checks the SQL compiles and every column matches the target schema (type, nullability, presence).' },
  { icon: ClipboardCheck, title: 'Submit & Approve', body: 'Save the mapping for review; an editor approves it. Approved mappings feed future generations.' },
];

// What to know to use it well.
const CONCEPTS = [
  { icon: FolderKanban, title: 'Projects', body: 'The instance-level scope — create one per source-system installation (e.g. two different Epic hospitals). Everything is scoped to a project.' },
  { icon: Network, title: 'Source Systems', body: 'The EHR system TYPE (Epic, Cerner…). One per project; it steers source-system-specific mapping instructions.' },
  { icon: Building2, title: 'Vendors', body: 'The EHR product a project’s source data comes from — a labelled name + code, managed in Admin.' },
  { icon: Database, title: 'Schema Versions', body: 'Your target schema can evolve. Each version points to a target-schema table; a project maps against one version.' },
  { icon: GitBranch, title: 'Cross-Project Learning', body: 'Optionally reuse approved mappings & history from other projects of the same source system to guide generation.' },
  { icon: ThumbsUp, title: 'Feedback & References', body: 'Thumbs-up/down on picks and curated example SQL continually sharpen the LLM’s attribute discovery.' },
];

const TIPS = [
  'Set up your Source Systems and Vendors in Admin first, then create a Project for each installation you’re mapping.',
  'Add a schema version in Admin → Target Schema Configuration and point your project at it, so the right target contract is used.',
  'Curate a few known-good mappings as References — they ground generation and dramatically improve quality.',
  'Use the 👍/👎 feedback on attribute matches; it steers future discovery for that target.',
  'Turn on Cross-Project Learning to bootstrap a new project from a sibling project’s approved work.',
  'Review and approve mappings on the Approvals page — only approved mappings feed the learning loop.',
];

export function AboutPage() {
  const navigate = useNavigate();
  return (
    <div className="w-full max-w-6xl pb-8 space-y-8">
      {/* Scoped entrance animation — respects reduced motion. */}
      <style>{`
        @keyframes am-fade-up { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
        .am-fade { opacity: 0; animation: am-fade-up .5s cubic-bezier(.2,.7,.3,1) both; }
        @media (prefers-reduced-motion: reduce) { .am-fade { animation: none; opacity: 1; } }
      `}</style>

      <PageHeader
        eyebrow="About"
        title="AI Mapper"
        description="AI-assisted source-to-target SQL mapping for healthcare data."
      />

      {/* Hero */}
      <Panel tone="ink" className="am-fade relative overflow-hidden px-8 py-8">
        <div aria-hidden className="pointer-events-none absolute -right-16 -top-24 h-72 w-72 rounded-full border-[28px] border-brand/25" />
        <div className="relative flex items-start gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-brand">
            <Waypoints className="h-6 w-6 text-white" />
          </div>
          <div className="max-w-2xl">
            <p className="flex items-center gap-2 text-[0.6875rem] font-semibold uppercase tracking-[0.1em] text-ink-muted">
              <span className="h-2 w-2 rounded-full bg-brand" /> Target mapping studio
            </p>
            <p className="mt-2 text-[0.9375rem] leading-relaxed text-ink-foreground/90">
              AI Mapper discovers how your EHR source tables map to a governed <span className="font-semibold text-white">target schema</span>,
              generates the transformation SQL, validates it against the contract, and runs a lightweight approval workflow — learning from every
              approved mapping to get better over time.
            </p>
          </div>
        </div>
      </Panel>

      {/* How it works */}
      <section>
        <h2 className="text-[1.25rem] font-bold tracking-tight">How it works</h2>
        <p className="text-sm text-muted-foreground mb-4">Six steps from source tables to an approved mapping.</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {STEPS.map((s, i) => {
            const Icon = s.icon;
            return (
              <Panel key={s.title} className="am-fade px-5 py-5">
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-bold text-brand tabular-nums">{String(i + 1).padStart(2, '0')}</span>
                    <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-surface-sunken text-foreground"><Icon className="h-4 w-4" /></span>
                  </div>
                  <h3 className="mt-3 text-[0.9375rem] font-bold">{s.title}</h3>
                  <p className="mt-1 text-[0.8125rem] text-muted-foreground leading-relaxed">{s.body}</p>
                </div>
              </Panel>
            );
          })}
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.35fr] gap-6 items-start">
        {/* Get started */}
        <Panel className="am-fade">
          <PanelHeader title="Get the most out of it" description="Setup order and habits that improve mapping quality." />
          <ol className="divide-y divide-border border-t border-border">
            {TIPS.map((t, i) => (
              <li key={t} className="flex items-start gap-3 px-6 py-3.5">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ink text-[0.6875rem] font-bold text-ink-foreground">{i + 1}</span>
                <p className="text-sm leading-relaxed">{t}</p>
              </li>
            ))}
          </ol>
        </Panel>

        {/* Key concepts */}
        <section>
          <h2 className="text-[1.25rem] font-bold tracking-tight mb-4">Key concepts</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {CONCEPTS.map((c) => {
              const Icon = c.icon;
              return (
                <Panel key={c.title} className="am-fade px-5 py-4">
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-soft text-brand-soft-foreground"><Icon className="h-4 w-4" /></span>
                    <h3 className="text-[0.9375rem] font-bold">{c.title}</h3>
                  </div>
                  <p className="mt-2 text-[0.8125rem] text-muted-foreground leading-relaxed">{c.body}</p>
                </Panel>
              );
            })}
          </div>
        </section>
      </div>

      {/* CTA */}
      <Panel className="flex flex-wrap items-center gap-3 px-6 py-4">
        <span className="text-sm font-semibold">Ready to map? Start from a project.</span>
        <button
          type="button"
          onClick={() => void navigate('/projects')}
          className="ml-auto inline-flex h-10 items-center gap-2 rounded-[0.625rem] bg-ink px-4 text-sm font-semibold text-ink-foreground hover:bg-ink-2"
        >
          Go to Projects <ArrowRight className="h-4 w-4" />
        </button>
      </Panel>
    </div>
  );
}
