import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  Button,
  Label,
  Skeleton,
} from '@databricks/appkit-ui/react';
import { SearchableSelect } from './SearchableSelect';
import { ShieldCheck } from 'lucide-react';
import { api, type UserPrefs } from '../../lib/aimapperApi';
import { useRole } from '../../lib/roleContext';
import { PageHeader, Panel, Avatar } from '../../components/studio';
import { displayName } from '../../lib/display';
import { cn } from '../../lib/utils';

const ROLE_LABEL: Record<string, string> = { viewer: 'Viewer', editor: 'Editor', admin: 'Admin' };
// Sentinel for "no preference" — Select can't hold an empty-string value.
const NONE = '__none__';

// Appearance choices rendered as selectable cards, each with a mini swatch.
const THEMES: { value: string; label: string; swatch: ReactNode }[] = [
  { value: 'light', label: 'Light', swatch: <span className="block h-6 w-11 rounded-md border border-[#dcd8d0] bg-[#f5f4f0]" /> },
  { value: 'dark', label: 'Dark', swatch: <span className="block h-6 w-11 rounded-md bg-[#1b2e36]" /> },
  {
    value: 'system',
    label: 'System',
    swatch: (
      <span className="flex h-6 w-11 overflow-hidden rounded-md border border-[#dcd8d0]">
        <span className="h-full w-1/2 bg-[#f5f4f0]" />
        <span className="h-full w-1/2 bg-[#1b2e36]" />
      </span>
    ),
  },
];

export function SettingsPage() {
  const { email, role, prefs, savePrefs } = useRole();

  // Local editable copy of the prefs.
  const [form, setForm] = useState<UserPrefs>(prefs);
  const [endpoints, setEndpoints] = useState<string[]>([]);
  const [catalogs, setCatalogs] = useState<string[]>([]);
  const [schemas, setSchemas] = useState<string[]>([]);
  const [targets, setTargets] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Keep the form in sync if prefs load after mount.
  useEffect(() => { setForm(prefs); }, [prefs]);

  useEffect(() => {
    let active = true;
    void (async () => {
      const [e, c, t] = await Promise.allSettled([api.endpoints(), api.catalogs(), api.targetEntities()]);
      if (!active) return;
      if (e.status === 'fulfilled') setEndpoints(e.value.endpoints.map((x) => x.name));
      if (c.status === 'fulfilled') setCatalogs(c.value.catalogs);
      if (t.status === 'fulfilled') setTargets(t.value.targets.map((x) => x.target_table));
      setLoading(false);
    })();
    return () => { active = false; };
  }, []);

  // Load schemas when the chosen default catalog changes.
  const loadSchemas = useCallback((catalog: string | null) => {
    if (!catalog) { setSchemas([]); return; }
    api.schemas(catalog).then((r) => setSchemas(r.schemas)).catch(() => setSchemas([]));
  }, []);

  useEffect(() => { loadSchemas(form.defaultCatalog); }, [form.defaultCatalog, loadSchemas]);

  function set<K extends keyof UserPrefs>(key: K, value: UserPrefs[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSave() {
    setSaving(true);
    setMsg(null);
    try {
      await savePrefs(form);
      setMsg('Preferences saved.');
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const theme = form.theme ?? 'system';

  return (
    <div className="space-y-6 w-full max-w-3xl">
      <PageHeader
        eyebrow="Account"
        title="Your settings"
        description="Personal preferences, saved to your account and applied wherever you sign in."
      />

      {/* Identity (read-only) */}
      <Panel className="px-6 py-5">
        <div className="flex flex-wrap items-center gap-4">
          <Avatar name={email} size="lg" />
          <div className="min-w-0 flex-1">
            <p className="text-[1.0625rem] font-bold truncate">{displayName(email)}</p>
            <p className="text-sm text-muted-foreground break-all">{email ?? '—'}</p>
          </div>
          <div className="flex flex-col items-start sm:items-end gap-1.5">
            <span className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2.5 py-0.5 text-xs font-semibold text-brand-soft-foreground">
              <ShieldCheck className="h-3 w-3" />
              {ROLE_LABEL[role] ?? role}
            </span>
            <span className="text-xs text-muted-foreground">Profile managed by an administrator</span>
          </div>
        </div>
      </Panel>

      {loading ? (
        <Panel className="px-6 py-5 space-y-3">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </Panel>
      ) : (
        <>
          {/* Appearance */}
          <Panel className="px-6 py-5">
            <h2 className="text-[1.0625rem] font-bold tracking-tight">Appearance</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">Choose how AI Mapper looks on this account.</p>
            <div role="radiogroup" aria-label="Appearance" className="mt-4 grid grid-cols-3 gap-3">
              {THEMES.map((t) => {
                const selected = theme === t.value;
                return (
                  <button
                    key={t.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => set('theme', t.value)}
                    className={cn(
                      'flex flex-col items-center gap-2 rounded-xl border px-4 py-3.5 text-sm font-semibold',
                      selected
                        ? 'border-brand bg-brand-soft text-foreground ring-1 ring-brand'
                        : 'border-input bg-card hover:border-foreground/30',
                    )}
                  >
                    {t.swatch}
                    {t.label}
                  </button>
                );
              })}
            </div>
          </Panel>

          {/* Mapper defaults */}
          <Panel className="px-6 py-5">
            <h2 className="text-[1.0625rem] font-bold tracking-tight">Mapper defaults</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">Values that pre-fill the Mapper. You can still change them on each run.</p>

            <div className="mt-4 space-y-4">
              <div className="space-y-1.5">
                <Label className="font-semibold">Default LLM endpoint</Label>
                <SearchableSelect
                  value={form.defaultEndpoint ?? NONE}
                  onValueChange={(v) => set('defaultEndpoint', v === NONE ? null : v)}
                  className="w-full"
                  placeholder="No default"
                  options={[{ value: NONE, label: 'No default' }, ...endpoints.map((e) => ({ value: e, label: e }))]}
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="font-semibold">Default source catalog</Label>
                  <SearchableSelect
                    value={form.defaultCatalog ?? NONE}
                    onValueChange={(v) => { const c = v === NONE ? null : v; set('defaultCatalog', c); set('defaultSchema', null); }}
                    className="w-full"
                    placeholder="No default"
                    options={[{ value: NONE, label: 'No default' }, ...catalogs.map((c) => ({ value: c, label: c }))]}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="font-semibold">Default source schema</Label>
                  <SearchableSelect
                    value={form.defaultSchema ?? NONE}
                    onValueChange={(v) => set('defaultSchema', v === NONE ? null : v)}
                    disabled={!form.defaultCatalog}
                    className="w-full"
                    placeholder={form.defaultCatalog ? 'No default' : 'Pick a catalog first'}
                    options={[{ value: NONE, label: 'No default' }, ...schemas.map((s) => ({ value: s, label: s }))]}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="font-semibold">Default target entity</Label>
                  <SearchableSelect
                    value={form.defaultTarget ?? NONE}
                    onValueChange={(v) => set('defaultTarget', v === NONE ? null : v)}
                    className="w-full"
                    placeholder="No default"
                    options={[{ value: NONE, label: 'No default' }, ...targets.map((t) => ({ value: t, label: t }))]}
                  />
                </div>
              </div>
            </div>

            <div className="mt-5 flex flex-wrap items-center justify-end gap-3 border-t border-border pt-4">
              {msg && <span className="mr-auto text-sm text-muted-foreground">{msg}</span>}
              <Button variant="outline" onClick={() => { setForm(prefs); setMsg(null); }} disabled={saving}>Reset</Button>
              <Button onClick={() => void handleSave()} disabled={saving}>{saving ? 'Saving…' : 'Save preferences'}</Button>
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}
