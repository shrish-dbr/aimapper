import { useMemo, useState } from 'react';
import { TableHead } from '@databricks/appkit-ui/react';
import { ChevronsUpDown, ChevronUp, ChevronDown } from 'lucide-react';

export type SortDir = 'asc' | 'desc';

/**
 * Generic client-side table sort. `get(row, key)` returns a comparable value for a
 * column key; numbers sort numerically, everything else naturally (numeric-aware).
 * Returns the sorted copy plus the current key/dir and a `toggle(key)` handler.
 */
export function useSort<T>(
  rows: T[],
  get: (row: T, key: string) => string | number | null | undefined,
  initialKey: string,
  initialDir: SortDir = 'asc',
) {
  const [sortKey, setSortKey] = useState(initialKey);
  const [sortDir, setSortDir] = useState<SortDir>(initialDir);

  function toggle(key: string) {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  }

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = get(a, sortKey);
      const bv = get(b, sortKey);
      let cmp: number;
      if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
      else cmp = String(av ?? '').localeCompare(String(bv ?? ''), undefined, { numeric: true, sensitivity: 'base' });
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return copy;
    // `get` is expected to be stable (module-level or memoized).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sortKey, sortDir]);

  return { sorted, sortKey, sortDir, toggle };
}

/** A clickable table header that shows the active sort direction. */
export function SortHead({
  label, sortKey: key, active, dir, onSort, className,
}: {
  label: string;
  sortKey: string;
  active: boolean;
  dir: SortDir;
  onSort: (key: string) => void;
  className?: string;
}) {
  return (
    <TableHead className={className}>
      <button type="button" onClick={() => onSort(key)} className="inline-flex items-center gap-1 hover:text-foreground transition-colors">
        {label}
        {active
          ? (dir === 'asc' ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />)
          : <ChevronsUpDown className="h-3.5 w-3.5 opacity-40" />}
      </button>
    </TableHead>
  );
}
