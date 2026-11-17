import { useMemo, useState } from 'react';
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  Checkbox,
  cn,
} from '@databricks/appkit-ui/react';
import { ChevronDown, Check } from 'lucide-react';

// A drop-in replacement for <Select> that adds an integrated search box. The CLOSED
// control is styled to match SelectTrigger, so it occupies no extra space on the page;
// the search field lives INSIDE the popup (a cmdk CommandInput at the top) on every
// dropdown, so all lists behave the same way.
export interface SearchableSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export function SearchableSelect({
  value,
  onValueChange,
  options,
  placeholder = '—',
  disabled,
  className,
  align = 'start',
  searchPlaceholder = 'Search…',
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: SearchableSelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  align?: 'start' | 'center' | 'end';
  searchPlaceholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = useMemo(() => options.find((o) => o.value === value), [options, value]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            'flex h-10 w-full items-center justify-between gap-2 rounded-[0.625rem] border border-input bg-card px-3.5 py-2 text-sm text-foreground transition-colors hover:border-foreground/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:opacity-70 data-[state=open]:border-foreground/30',
            className,
          )}
        >
          <span className={`truncate text-left ${selected ? '' : 'text-muted-foreground'}`}>
            {selected ? selected.label : placeholder}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-[8rem] p-0 rounded-[0.625rem] overflow-hidden" align={align}>
        <Command>
          <CommandInput placeholder={searchPlaceholder} className="h-9" />
          <CommandList>
            <CommandEmpty>No results.</CommandEmpty>
            <CommandGroup>
              {options.map((o) => (
                <CommandItem
                  key={o.value}
                  value={o.label}
                  keywords={[o.value]}
                  disabled={o.disabled}
                  onSelect={() => {
                    onValueChange(o.value);
                    setOpen(false);
                  }}
                >
                  <Check className={`mr-2 h-4 w-4 shrink-0 text-brand ${o.value === value ? 'opacity-100' : 'opacity-0'}`} />
                  <span className="truncate">{o.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// Searchable multi-select: the same trigger and search box as SearchableSelect, with a
// checkbox per option and All / None shortcuts. The popup stays open while picking.
// All / None apply to the options matching the current search, so "search, then All"
// selects just those.
export function SearchableMultiSelect({
  values,
  onValuesChange,
  options,
  summary,
  title,
  disabled,
  className,
  contentClassName = 'w-72',
  align = 'start',
  searchPlaceholder = 'Search…',
  itemClassName,
}: {
  values: Set<string>;
  onValuesChange: (values: Set<string>) => void;
  options: SearchableSelectOption[];
  /** Text shown in the closed control, e.g. "3 of 12 selected". */
  summary: string;
  /** Heading above the list, e.g. "Tables to search". */
  title?: string;
  disabled?: boolean;
  className?: string;
  contentClassName?: string;
  align?: 'start' | 'center' | 'end';
  searchPlaceholder?: string;
  itemClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q)) : options;
  }, [options, search]);
  const toggle = (v: string) => {
    const next = new Set(values);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    onValuesChange(next);
  };
  const setVisible = (on: boolean) => {
    const next = new Set(values);
    for (const o of visible) {
      if (o.disabled) continue;
      if (on) next.add(o.value);
      else next.delete(o.value);
    }
    onValuesChange(next);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setSearch('');
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            'flex h-10 w-full items-center justify-between gap-2 rounded-[0.625rem] border border-input bg-card px-3.5 py-2 text-sm text-foreground transition-colors hover:border-foreground/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:opacity-70 data-[state=open]:border-foreground/30',
            className,
          )}
        >
          <span className="truncate text-left">{summary}</span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className={cn('min-w-[8rem] p-0 rounded-[0.625rem] overflow-hidden', contentClassName)} align={align}>
        {/* Filtering is done here (not by cmdk) so All / None can act on the visible options. */}
        <Command shouldFilter={false}>
          <CommandInput placeholder={searchPlaceholder} className="h-9" value={search} onValueChange={setSearch} />
          <div className="flex items-center justify-between gap-2 border-b px-2 py-1.5">
            <span className="truncate text-xs font-semibold text-muted-foreground">{title}</span>
            <div className="flex shrink-0 items-center gap-1">
              <button type="button" className="rounded px-1.5 py-0.5 text-xs hover:bg-muted" onClick={() => setVisible(true)}>
                All
              </button>
              <button type="button" className="rounded px-1.5 py-0.5 text-xs hover:bg-muted" onClick={() => setVisible(false)}>
                None
              </button>
            </div>
          </div>
          <CommandList className="max-h-72">
            <CommandEmpty>No results.</CommandEmpty>
            <CommandGroup>
              {visible.map((o) => {
                const on = values.has(o.value);
                return (
                  <CommandItem key={o.value} value={o.value} disabled={o.disabled} onSelect={() => toggle(o.value)} className="gap-2">
                    <Checkbox checked={on} className="pointer-events-none" aria-hidden />
                    <span className={cn('truncate', itemClassName)} title={o.label}>
                      {o.label}
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
