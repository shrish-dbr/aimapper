import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Button,
  Input,
  Label,
  Skeleton,
  Alert,
  AlertTitle,
  AlertDescription,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '@databricks/appkit-ui/react';
import { SearchableSelect } from './SearchableSelect';
import { FolderKanban, Plus, Pencil, Trash2, ArrowRight, CheckCircle2 } from 'lucide-react';
import { api, type Project, type Vendor, type SchemaVersion } from '../../lib/aimapperApi';
import { useRole } from '../../lib/roleContext';
import { PageHeader, Panel, Chip, Tag, Meter, SearchField, EmptyState } from '../../components/studio';

const VENDOR_NONE = '__none__';
const num = (v: number | string | null | undefined): number => (v == null ? 0 : Number(v) || 0);

export function ProjectsPage() {
  const { isEditor, isAdmin } = useRole();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [totalTargets, setTotalTargets] = useState(0);
  const [sourceSystems, setSourceSystems] = useState<string[]>([]);
  const [defaultSourceSystem, setDefaultSourceSystem] = useState('Epic');
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [schemaVersions, setSchemaVersions] = useState<SchemaVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<Project | null>(null);

  // Create / edit dialog.
  const [dlgOpen, setDlgOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null); // null = create
  const [fName, setFName] = useState('');
  const [fDesc, setFDesc] = useState('');
  const [fSourceSystem, setFSourceSystem] = useState('');
  const [fVendor, setFVendor] = useState(VENDOR_NONE);
  const [fSchemaVersion, setFSchemaVersion] = useState('');
  const [dlgErr, setDlgErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const defaultVersionId = schemaVersions.find((v) => String(v.is_default).toLowerCase() === 'true')?.version_id ?? schemaVersions[0]?.version_id ?? '';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, s, v, pv] = await Promise.all([api.projects(), api.sourceSystems(), api.vendors(), api.schemaVersions()]);
      setProjects(p.projects);
      setTotalTargets(p.totalTargets ?? 0);
      setSourceSystems(s.sourceSystems);
      setDefaultSourceSystem(s.defaultSourceSystem);
      setVendors(v.vendors);
      setSchemaVersions(pv.versions);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function openCreate() {
    setEditId(null); setFName(''); setFDesc(''); setFSourceSystem(defaultSourceSystem); setFVendor(VENDOR_NONE); setFSchemaVersion(defaultVersionId); setDlgErr(null); setDlgOpen(true);
  }
  function openEdit(p: Project) {
    setEditId(p.project_id); setFName(p.name); setFDesc(p.description ?? ''); setFSourceSystem(p.source_system); setFVendor(p.vendor_code || VENDOR_NONE); setFSchemaVersion(p.schema_version_id || defaultVersionId); setDlgErr(null); setDlgOpen(true);
  }

  async function handleSave() {
    const name = fName.trim();
    if (!name) { setDlgErr('A project name is required.'); return; }
    setSaving(true); setDlgErr(null); setMsg(null);
    try {
      if (editId) {
        await api.updateProject({ projectId: editId, name, description: fDesc.trim(), vendorCode: fVendor === VENDOR_NONE ? null : fVendor, schemaVersionId: fSchemaVersion || undefined });
        setMsg(`Project '${name}' updated.`);
      } else {
        await api.createProject({ name, sourceSystem: fSourceSystem || defaultSourceSystem, description: fDesc.trim() || undefined, vendorCode: fVendor === VENDOR_NONE ? undefined : fVendor, schemaVersionId: fSchemaVersion || undefined });
        setMsg(`Project '${name}' created.`);
      }
      setDlgOpen(false);
      await load();
    } catch (err) {
      setDlgErr(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(p: Project) {
    setConfirmDelete(null); setBusy(true); setError(null); setMsg(null);
    try { await api.deleteProject(p.project_id); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }

  // Open a project in the Mapper (pre-selects it there).
  function openInMapper(p: Project) {
    void navigate('/mapper', { state: { selectProject: p.project_id } });
  }

  const needle = q.trim().toLowerCase();
  const filtered = needle
    ? projects.filter((p) => [p.name, p.source_system, p.vendor_name, p.description, p.schema_version_label]
        .some((f) => String(f ?? '').toLowerCase().includes(needle)))
    : projects;

  const sourceSystemCount = new Set(projects.map((p) => p.source_system)).size;

  return (
    <div className="space-y-6 w-full">
      <PageHeader
        eyebrow="Workspace"
        title="Projects"
        description="Each project is an instance-level mapping scope — one source system, an optional vendor."
        actions={isEditor && (
          <Button size="lg" onClick={openCreate}><Plus className="h-4 w-4" /> New project</Button>
        )}
      />

      {error && <Alert variant="destructive"><AlertTitle>Error</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
      {msg && <Alert><CheckCircle2 className="h-4 w-4" /><AlertTitle>Saved</AlertTitle><AlertDescription>{msg}</AlertDescription></Alert>}

      {!loading && projects.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SearchField value={q} onChange={setQ} placeholder="Search projects…" className="w-full sm:max-w-md" />
          <p className="text-sm text-muted-foreground">
            {projects.length} project{projects.length === 1 ? '' : 's'} · {sourceSystemCount} source system{sourceSystemCount === 1 ? '' : 's'}
          </p>
        </div>
      )}

      {loading && <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-72 w-full rounded-[var(--radius)]" />)}</div>}

      {!loading && projects.length === 0 && (
        <EmptyState icon={<FolderKanban className="h-7 w-7 opacity-60" />}>
          No projects yet.{isEditor ? ' Click “New project” to add one.' : ' Ask an editor to add one.'}
        </EmptyState>
      )}
      {!loading && projects.length > 0 && filtered.length === 0 && (
        <p className="text-sm text-muted-foreground">No projects match “{q}”.</p>
      )}

      {!loading && filtered.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {filtered.map((p) => {
            const isDefault = p.project_id.startsWith('default::');
            const mapped = num(p.mapped_targets);
            const coverage = totalTargets ? Math.round((mapped / totalTargets) * 100) : 0;
            const runs = num(p.run_count);
            const inReview = num(p.in_review);
            return (
              <Panel key={p.project_id} className="flex flex-col p-6">
                <div className="flex items-center gap-2 min-w-0">
                  <h3 className="text-[1.25rem] font-bold tracking-tight truncate" title={p.name}>{p.name}</h3>
                  {isDefault && <Tag className="uppercase tracking-[0.06em]">Default</Tag>}
                </div>
                <div className="flex items-center gap-1.5 flex-wrap mt-3">
                  <Chip dot title="Source system">{p.source_system}</Chip>
                  {p.vendor_name && <Chip title="Vendor">{p.vendor_name}</Chip>}
                  {p.schema_version_label && <Chip title="Target-schema version">{p.schema_version_label}</Chip>}
                </div>
                <p className={`mt-3 text-[0.9375rem] line-clamp-2 ${p.description ? 'text-muted-foreground' : 'text-muted-foreground/70'}`}>
                  {p.description || 'No description yet.'}
                </p>

                <div className="mt-5">
                  <div className="flex items-center justify-between text-sm mb-2">
                    <span className="text-muted-foreground">Target coverage</span>
                    <span className="font-bold tabular-nums">{coverage}%</span>
                  </div>
                  <Meter value={coverage / 100} />
                </div>

                <div className="grid grid-cols-2 gap-3 mt-5">
                  <div className="rounded-xl bg-surface-sunken px-4 py-3">
                    <p className="text-[1.5rem] leading-none font-bold tabular-nums">{runs}</p>
                    <p className="mt-1.5 text-xs text-muted-foreground">runs</p>
                  </div>
                  <div className="rounded-xl bg-surface-sunken px-4 py-3">
                    <p className="text-[1.5rem] leading-none font-bold tabular-nums">{inReview}</p>
                    <p className="mt-1.5 text-xs text-muted-foreground">awaiting review</p>
                  </div>
                </div>

                <div className="flex items-center gap-2 mt-auto pt-5">
                  <Button className="flex-1 h-10 bg-ink text-ink-foreground hover:bg-ink/90" onClick={() => openInMapper(p)}>
                    Open in Mapper <ArrowRight className="h-4 w-4" />
                  </Button>
                  {isEditor && (
                    <Button variant="outline" size="icon" className="h-10 w-10" title="Edit project" onClick={() => openEdit(p)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                  )}
                  {isAdmin && (
                    <Button variant="outline" size="icon" className="h-10 w-10" title={isDefault ? 'Default projects cannot be deleted' : 'Delete project'} disabled={isDefault || busy} onClick={() => setConfirmDelete(p)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </Panel>
            );
          })}
        </div>
      )}

      {/* Create / edit dialog */}
      <Dialog open={dlgOpen} onOpenChange={(o) => { setDlgOpen(o); if (!o) setDlgErr(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editId ? 'Edit project' : 'New project'}</DialogTitle>
            <DialogDescription>{editId ? 'The source system is fixed after creation.' : 'One source system per project; the vendor is where the source EHR comes from.'}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Project name</Label>
              <Input value={fName} onChange={(e) => setFName(e.target.value)} placeholder="e.g. Hospital A — Epic" />
            </div>
            <div className="space-y-1">
              <Label>Source system{editId ? '' : ''}</Label>
              <SearchableSelect
                value={fSourceSystem}
                onValueChange={setFSourceSystem}
                disabled={!!editId || !sourceSystems.length}
                className="w-full"
                placeholder="Select source system"
                options={sourceSystems.map((s) => ({ value: s, label: s }))}
              />
              {editId && <p className="text-xs text-muted-foreground">Source system can’t be changed — it scopes existing mappings.</p>}
            </div>
            <div className="space-y-1">
              <Label>Vendor <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <SearchableSelect
                value={fVendor}
                onValueChange={setFVendor}
                className="w-full"
                placeholder="Select vendor"
                options={[{ value: VENDOR_NONE, label: '— None —' }, ...vendors.map((v) => ({ value: v.vendor_code, label: `${v.name} (${v.vendor_code})` }))]}
              />
            </div>
            <div className="space-y-1">
              <Label>Schema version</Label>
              <SearchableSelect
                value={fSchemaVersion}
                onValueChange={setFSchemaVersion}
                disabled={!schemaVersions.length}
                className="w-full"
                placeholder="Select schema version"
                options={schemaVersions.map((v) => ({ value: v.version_id, label: `${v.label}${String(v.is_default).toLowerCase() === 'true' ? ' · default' : ''}` }))}
              />
              <p className="text-xs text-muted-foreground">Mappings in this project use this target-schema version.</p>
            </div>
            <div className="space-y-1">
              <Label>Description <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Input value={fDesc} onChange={(e) => setFDesc(e.target.value)} placeholder="Short note" />
            </div>
            {dlgErr && <p className="text-xs text-destructive">{dlgErr}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDlgOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={() => void handleSave()} disabled={saving || !fName.trim()}>{saving ? 'Saving…' : editId ? 'Save Changes' : 'Create Project'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => { if (!o) setConfirmDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete project?</AlertDialogTitle>
            <AlertDialogDescription>Delete <span className="font-medium">{confirmDelete?.name}</span>? This can’t be undone. Any mappings in this project are moved to its source system’s default project (not lost).</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (confirmDelete) void handleDelete(confirmDelete); }}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
