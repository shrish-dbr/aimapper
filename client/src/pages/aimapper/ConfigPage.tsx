import { useCallback, useEffect, useState } from 'react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  Button,
  Label,
  Input,
  Checkbox,
  Alert,
  AlertTitle,
  AlertDescription,
  Skeleton,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '@databricks/appkit-ui/react';
import { Tag, Mono } from '../../components/studio';
import { SearchableSelect } from './SearchableSelect';
import { CheckCircle2, XCircle, Database, Save, Pencil, Eye, RefreshCw, Plus, Trash2, Star } from 'lucide-react';
import { api, type SchemaVersion } from '../../lib/aimapperApi';

type Check = { ok: boolean; message: string; targetCount?: number };
function isDefault(v: SchemaVersion): boolean {
  return String(v.is_default).toLowerCase() === 'true';
}

/**
 * schema versions configuration. Each version is a labelled pointer to a target-schema
 * table (with a description). Admins create versions, update a version's target table
 * / description / label, set the default, and delete versions. Rendered as an Admin tab.
 */
export function ConfigPanel({ onSaved }: { onSaved?: () => void }) {
  const [versions, setVersions] = useState<SchemaVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<SchemaVersion | null>(null);

  // Editor (create or edit one version).
  const [editorOpen, setEditorOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null); // null = create
  const [fLabel, setFLabel] = useState('');
  const [fDesc, setFDesc] = useState('');
  const [fMakeDefault, setFMakeDefault] = useState(false);
  const [catalogs, setCatalogs] = useState<string[]>([]);
  const [schemas, setSchemas] = useState<string[]>([]);
  const [tables, setTables] = useState<string[]>([]);
  const [catalog, setCatalog] = useState('');
  const [schema, setSchema] = useState('');
  const [table, setTable] = useState('');
  const [check, setCheck] = useState<Check | null>(null);
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);

  // Preview (top 100 rows of one version's table).
  const [previewFor, setPreviewFor] = useState<string | null>(null); // version_id
  const [preview, setPreview] = useState<{ table: string; columns: string[]; rows: (string | null)[][] } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setVersions((await api.schemaVersions()).versions);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Load catalogs the first time the editor opens.
  useEffect(() => {
    if (!editorOpen || catalogs.length) return;
    api.catalogs().then((c) => setCatalogs(c.catalogs)).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [editorOpen, catalogs.length]);

  useEffect(() => {
    setSchema(''); setTable(''); setSchemas([]); setTables([]); setCheck(null);
    if (!catalog) return;
    api.schemas(catalog).then((s) => setSchemas(s.schemas)).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [catalog]);

  useEffect(() => {
    setTable(''); setTables([]); setCheck(null);
    if (!catalog || !schema) return;
    api.tables(catalog, schema).then((t) => setTables(t.tables)).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [catalog, schema]);

  useEffect(() => { setCheck(null); }, [table]);

  const chosen = catalog && schema && table ? `${catalog}.${schema}.${table}` : '';

  function openCreate() {
    setEditId(null); setFLabel(''); setFDesc(''); setFMakeDefault(versions.length === 0);
    setCatalog(''); setSchema(''); setTable(''); setCheck(null); setMsg(null); setError(null);
    setEditorOpen(true);
  }

  function openEdit(v: SchemaVersion) {
    setEditId(v.version_id); setFLabel(v.label); setFDesc(v.description ?? ''); setFMakeDefault(isDefault(v));
    // Prefill the table cascade from the version's fully-qualified table.
    const [c, s, t] = (v.target_schema_table ?? '').split('.');
    setCatalog(c ?? ''); setSchema(s ?? ''); setTable(t ?? ''); setCheck(null); setMsg(null); setError(null);
    setEditorOpen(true);
  }

  async function handleValidate() {
    if (!chosen) return;
    setValidating(true); setError(null);
    try { setCheck(await api.validateConfig(catalog, schema, table)); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setValidating(false); }
  }

  // The table only needs (re)validating when it changed from the version's current one.
  const tableChanged = editId ? chosen !== (versions.find((v) => v.version_id === editId)?.target_schema_table ?? '') : true;

  async function handleSave() {
    setSaving(true); setError(null); setMsg(null);
    try {
      if (editId) {
        const res = await api.updateSchemaVersion({
          versionId: editId,
          label: fLabel.trim(),
          description: fDesc.trim(),
          isDefault: fMakeDefault || undefined,
          ...(tableChanged && catalog && schema && table ? { catalog, schema, table } : {}),
        });
        if (res.ok === false && res.message) { setCheck({ ok: false, message: res.message }); return; }
        setMsg(`Version '${fLabel.trim()}' updated.`);
      } else {
        const res = await api.createSchemaVersion({ label: fLabel.trim(), catalog, schema, table, description: fDesc.trim(), isDefault: fMakeDefault });
        if (res.ok === false && res.message) { setCheck({ ok: false, message: res.message }); return; }
        setMsg(`Version '${fLabel.trim()}' created${res.targetCount ? ` (${res.targetCount} target entities)` : ''}.`);
      }
      setEditorOpen(false);
      await load();
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleSetDefault(v: SchemaVersion) {
    setBusy(true); setError(null); setMsg(null);
    try { await api.updateSchemaVersion({ versionId: v.version_id, isDefault: true }); await load(); onSaved?.(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }

  async function handleDelete(v: SchemaVersion) {
    setConfirmDelete(null); setBusy(true); setError(null); setMsg(null);
    try { await api.deleteSchemaVersion(v.version_id); if (previewFor === v.version_id) { setPreviewFor(null); setPreview(null); } await load(); onSaved?.(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }

  async function togglePreview(v: SchemaVersion) {
    if (previewFor === v.version_id) { setPreviewFor(null); setPreview(null); setPreviewError(null); return; }
    setPreviewFor(v.version_id); setPreview(null); setPreviewError(null); setPreviewLoading(true);
    try {
      const res = await api.targetSchemaPreview(v.target_schema_table);
      if (res.error) { setPreviewError(res.error); }
      else setPreview({ table: res.table, columns: res.columns, rows: res.rows });
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewLoading(false);
    }
  }

  const canValidate = !editId || tableChanged;
  const canSave = Boolean(fLabel.trim()) && (editId ? (!tableChanged || check?.ok) : check?.ok);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 max-w-3xl">
        <h2 className="text-[1.375rem] font-bold tracking-tight text-foreground">Target schema configuration</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage target-schema versions. Each version points to a Unity Catalog target-schema table; the Mapper picks a
          version and every target reference follows it. The <span className="font-medium text-foreground">default</span> version is pre-selected.
        </p>
        </div>
        <Button onClick={openCreate}><Plus className="h-4 w-4 mr-1.5" /> New Version</Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <XCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {msg && (
        <Alert>
          <CheckCircle2 className="h-4 w-4" />
          <AlertTitle>Saved</AlertTitle>
          <AlertDescription>{msg}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><Database className="h-4 w-4 text-brand" /> Schema versions</CardTitle>
          <CardDescription>The default version cannot be un-set directly — set another as default instead. At least one version must remain.</CardDescription>
        </CardHeader>
        <CardContent>
          {loading && <div className="space-y-2"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></div>}
          {!loading && versions.length === 0 && <p className="text-sm text-muted-foreground">No schema versions yet. Add one to get started.</p>}
          {!loading && versions.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Version</TableHead>
                  <TableHead>Target table</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {versions.map((v) => (
                  <TableRow key={v.version_id}>
                    <TableCell className="text-sm font-medium">
                      {v.label}
                      {isDefault(v) && <Tag className="ml-2 uppercase tracking-wide">Default</Tag>}
                    </TableCell>
                    <TableCell className="max-w-[18rem] truncate" title={v.target_schema_table}><Mono className="text-xs">{v.target_schema_table}</Mono></TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-[18rem] truncate" title={v.description ?? ''}>{v.description || '—'}</TableCell>
                    <TableCell className="text-right whitespace-nowrap py-2.5">
                      <Button variant="outline" size="icon-sm" className="ml-1.5" title={previewFor === v.version_id ? 'Hide preview' : 'Preview rows'} onClick={() => void togglePreview(v)}>
                        <Eye className="h-4 w-4" />
                      </Button>
                      <Button variant="outline" size="icon-sm" className="ml-1.5" title="Edit version" onClick={() => openEdit(v)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      {!isDefault(v) && (
                        <Button variant="outline" size="icon-sm" className="ml-1.5" title="Set as default" disabled={busy} onClick={() => void handleSetDefault(v)}>
                          <Star className="h-4 w-4" />
                        </Button>
                      )}
                      <Button variant="outline" size="icon-sm" className="ml-1.5" title={versions.length <= 1 ? 'At least one version must remain' : 'Delete version'} disabled={busy || versions.length <= 1} onClick={() => setConfirmDelete(v)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Preview: top 100 rows of the chosen version's table. */}
      {previewFor && (
        <Card>
          <CardHeader className="flex-row items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base">Preview · top 100 rows</CardTitle>
              <CardDescription>
                <Mono className="font-medium text-foreground">{versions.find((v) => v.version_id === previewFor)?.target_schema_table}</Mono>
                {preview ? ` — ${preview.rows.length} row${preview.rows.length === 1 ? '' : 's'}` : ''}
              </CardDescription>
            </div>
            <Button variant="ghost" size="sm" onClick={() => { const v = versions.find((x) => x.version_id === previewFor); if (v) { setPreviewFor(null); void togglePreview(v); } }} disabled={previewLoading}>
              <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${previewLoading ? 'animate-spin' : ''}`} /> Refresh
            </Button>
          </CardHeader>
          <CardContent>
            {previewLoading && <div className="space-y-2"><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /></div>}
            {previewError && (
              <Alert variant="destructive"><XCircle className="h-4 w-4" /><AlertTitle>Could not load preview</AlertTitle><AlertDescription>{previewError}</AlertDescription></Alert>
            )}
            {!previewLoading && !previewError && preview && preview.rows.length === 0 && <p className="text-sm text-muted-foreground">The table has no rows.</p>}
            {!previewLoading && !previewError && preview && preview.rows.length > 0 && (
              <div className="overflow-auto max-h-[28rem] border rounded-xl thin-scroll">
                <Table>
                  <TableHeader>
                    <TableRow>{preview.columns.map((c) => <TableHead key={c} className="whitespace-nowrap">{c}</TableHead>)}</TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.rows.map((row, i) => (
                      <TableRow key={i}>
                        {row.map((val, j) => (
                          <TableCell key={j} className="font-mono text-xs whitespace-nowrap max-w-xs truncate" title={val ?? ''}>
                            {val ?? <span className="text-muted-foreground italic">null</span>}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Editor: create or edit a version. */}
      {editorOpen && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{editId ? 'Edit schema version' : 'New schema version'}</CardTitle>
            <CardDescription>Give it a label and description, pick catalog → schema → table, validate, then save.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label>Version label</Label>
                <Input value={fLabel} onChange={(e) => setFLabel(e.target.value)} placeholder="e.g. v2.3" />
              </div>
              <div className="space-y-1">
                <Label>Description <span className="text-muted-foreground font-normal">(optional)</span></Label>
                <Input value={fDesc} onChange={(e) => setFDesc(e.target.value)} placeholder="What changed in this version" />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-1">
                <Label>Catalog</Label>
                <SearchableSelect
                  value={catalog}
                  onValueChange={setCatalog}
                  className="w-full"
                  placeholder="Select catalog"
                  options={catalogs.map((c) => ({ value: c, label: c }))}
                />
              </div>
              <div className="space-y-1">
                <Label>Schema</Label>
                <SearchableSelect
                  value={schema}
                  onValueChange={setSchema}
                  disabled={!catalog}
                  className="w-full"
                  placeholder="Select schema"
                  options={schemas.map((s) => ({ value: s, label: s }))}
                />
              </div>
              <div className="space-y-1">
                <Label>Table</Label>
                <SearchableSelect
                  value={table}
                  onValueChange={setTable}
                  disabled={!schema}
                  className="w-full"
                  placeholder="Select table"
                  options={tables.map((t) => ({ value: t, label: t }))}
                />
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              Any table in any catalog and schema works if it has one row per target column with a table name, column
              name and data type, under common names such as <Mono className="text-xs">target_table</Mono> /{' '}
              <Mono className="text-xs">table_name</Mono>, <Mono className="text-xs">target_column</Mono> /{' '}
              <Mono className="text-xs">column_name</Mono> and <Mono className="text-xs">data_type</Mono> /{' '}
              <Mono className="text-xs">type</Mono>. Position, nullability, description and similar columns are used when
              present.
            </p>
            {chosen && <p className="text-xs text-muted-foreground">Target table: <Mono className="font-medium text-foreground text-xs">{chosen}</Mono></p>}

            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox checked={fMakeDefault} onCheckedChange={(v) => setFMakeDefault(v === true)} />
              Set as the default version
            </label>

            {check && (
              <Alert variant={check.ok ? 'default' : 'destructive'}>
                {check.ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
                <AlertTitle>{check.ok ? 'Valid target-schema table' : 'Not a valid target-schema table'}</AlertTitle>
                <AlertDescription>{check.message}</AlertDescription>
              </Alert>
            )}

            <div className="flex items-center gap-3 flex-wrap">
              {canValidate && (
                <Button variant="outline" onClick={() => void handleValidate()} disabled={!chosen || validating}>
                  <CheckCircle2 className="h-4 w-4 mr-1.5" /> {validating ? 'Validating…' : 'Validate table'}
                </Button>
              )}
              <Button onClick={() => void handleSave()} disabled={!canSave || saving}>
                <Save className="h-4 w-4 mr-1.5" /> {saving ? 'Saving…' : editId ? 'Save Changes' : 'Create Version'}
              </Button>
              <Button variant="ghost" onClick={() => setEditorOpen(false)}>Cancel</Button>
              {canValidate && !check?.ok && <p className="text-xs text-muted-foreground">Validate the table before saving.</p>}
            </div>
          </CardContent>
        </Card>
      )}

      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => { if (!o) setConfirmDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete schema version?</AlertDialogTitle>
            <AlertDialogDescription>
              Delete <span className="font-medium">{confirmDelete?.label}</span>? This removes the version pointer (the
              underlying table is not touched). Mappings that referenced it keep their saved SQL.
            </AlertDialogDescription>
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
