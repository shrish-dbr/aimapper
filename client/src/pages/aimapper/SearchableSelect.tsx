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
  cn,
} from '@databricks/appkit-ui/react';
import { ChevronDown, Check } from 'lucide-react';

// A drop-in replacement for <Select> that adds an integrated search box. The CLOSED
// control is styled to match SelectTrigger, so it occupies no extra space on the page;
// the search field lives INSIDE the popup (a cmdk CommandInput at the top), and appears
// only once the list is long enough to be worth filtering.
export interface SearchableSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

// Show the search box only when the list has at least this many options — small, fixed
// lists (yes/no, a handful of statuses) don't get a pointless search field.
const SEARCH_MIN_OPTIONS = 8;

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
  const showSearch = options.length >= SEARCH_MIN_OPTIONS;
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
          {showSearch && <CommandInput placeholder={searchPlaceholder} className="h-9" />}
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
