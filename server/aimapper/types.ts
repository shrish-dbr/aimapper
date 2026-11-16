// Shared types for the aimapper plugin. Framework-free so both the route
// handlers and the prompt builder can import them.

/** A column in a source Unity Catalog table (from tables.get). */
export interface SourceColumn {
  name: string;
  typeName: string; // STRING, INT, DATE, DECIMAL, ...
  typeText?: string; // full text e.g. decimal(10,2)
  nullable: boolean;
  position: number;
  comment?: string;
}

/** A source table with its fully-qualified name and column metadata. */
export interface SourceTable {
  catalog: string;
  schema: string;
  table: string;
  columns: SourceColumn[];
}

/** One column of a target contract (mirrors target_schema). */
export interface TargetColumn {
  target_table: string;
  target_column: string;
  ordinal_position: number;
  data_type: string;
  data_length: number | null;
  numeric_precision: number | null;
  numeric_scale: number | null;
  is_nullable: boolean;
  is_primary_key: boolean | null;
  description: string | null;
  transform_hint: string | null;
}

/** A target = its name plus the ordered column contract. */
export interface TargetEntity {
  target_table: string;
  columns: TargetColumn[];
}

/**
 * Target-driven attribute mapping: for ONE target column, the best-matching
 * source column across ANY searched source table. source_table/source_column
 * are null when there is no confident match (or the user cleared it).
 */
export interface AttributeMapping {
  target_column: string;
  source_table: string | null;
  source_column: string | null;
  confidence: number; // 0..1
  rationale: string;
}

/** Per-column outcome of validating generated SQL against the target contract. */
export interface ColumnDiff {
  target_column: string;
  status: 'matched' | 'type_mismatch' | 'missing' | 'extra' | 'nullability_mismatch';
  expected?: string;
  actual?: string;
  detail?: string;
}

/** Result of validating one generated SELECT against a target. */
export interface ValidationReport {
  status: 'SUCCESS' | 'WARNINGS' | 'FAILED';
  compiles: boolean;
  errorMessage?: string;
  columns: ColumnDiff[];
}

/** A single source->target item persisted to history. */
export interface RunItem {
  itemId: string;
  sourceCatalog: string;
  sourceSchema: string;
  sourceTable: string;
  targetTable: string | null;
  matchMethod: string;
  matchConfidence: number | null;
  matchRationale: string | null;
  generatedSql: string | null;
  status: 'SUCCESS' | 'WARNINGS' | 'FAILED' | 'SKIPPED';
  validationReport: ValidationReport | null;
  errorMessage: string | null;
  durationMs: number | null;
  /** JSON of the AttributeMapping[] that produced this SQL — enables reload & lineage. */
  mappingsJson?: string | null;
  /** Source system (EHR type) this mapping belongs to; defaults to Epic. */
  sourceSystem?: string | null;
  /** Project (instance-level scope) this mapping belongs to; defaults to the source
   * system's default project when unset. */
  projectId?: string | null;
  /** LLM token usage for the whole task (identify + generate), if captured. */
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
}

/** Token usage from a serving-endpoint chat response. */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** A curated known-good source->target conversion used as a few-shot reference. */
export interface MappingExample {
  example_id: string;
  target_table: string;
  source_signature: string | null;
  source_columns?: string | null;
  generated_sql: string;
  notes: string | null;
  approved: boolean;
  created_by: string | null;
  created_at: string;
}
