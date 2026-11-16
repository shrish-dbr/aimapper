// Searchable picker for the Admin "Assign a role" form: lists the workspace's users
// and groups (grouped), and still accepts a typed email that isn't in the list, so
// assigning works even when the directory can't be read.
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
  CommandSeparator,
  cn,
} from '@databricks/appkit-ui/react';
import { ChevronDown, Check, Users, User, CornerDownLeft } from 'lucide-react';
import type { PrincipalType, WorkspacePrincipals } from '../../lib/aimapperApi';

export interface PickedPrincipal {
  name: string;
  type: PrincipalType;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function PrincipalPicker({
  value,
  onChange,
  principals,
  loading,
  className,
}: {
  value: PickedPrincipal | null;
  onChange: (p: PickedPrincipal | null) => void;
  principals: WorkspacePrincipals | null;
  loading: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const users = useMemo(() => principals?.users ?? [], [principals]);
  const groups = useMemo(() => principals?.groups ?? [], [principals]);

  // Offer the typed text as a user email when it looks like one and isn't listed.
  const typed = search.trim();
  const typedIsNew = useMemo(
    () => EMAIL_RE.test(typed) && !users.some((u) => u.userName.toLowerCase() === typed.toLowerCase()),
    [typed, users],
  );

  const pick = (p: PickedPrincipal) => {
    onChange(p);
    setOpen(false);
    setSearch('');
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-label="User or group"
          className={cn(
            'flex h-10 w-full items-center justify-between gap-2 rounded-[0.625rem] border border-input bg-card px-3.5 py-2 text-sm text-foreground transition-colors hover:border-foreground/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 data-[state=open]:border-foreground/30',
            className,
          )}
        >
          {value ? (
            <span className="flex min-w-0 items-center gap-2">
              {value.type === 'group' ? <Users className="h-4 w-4 shrink-0 text-muted-foreground" /> : <User className="h-4 w-4 shrink-0 text-muted-foreground" />}
              <span className="truncate">{value.name}</span>
              {value.type === 'group' && <span className="rounded-md bg-muted px-1.5 py-0.5 text-[0.6875rem] font-semibold text-muted-foreground">Group</span>}
            </span>
          ) : (
            <span className="truncate text-muted-foreground">{loading ? 'Loading users & groups…' : 'Select a user or group'}</span>
          )}
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-[18rem] p-0 rounded-[0.625rem] overflow-hidden" align="start">
        <Command>
          <CommandInput placeholder="Search users and groups, or type an email…" value={search} onValueChange={setSearch} className="h-10" />
          <CommandList className="max-h-80">
            <CommandEmpty>{typed ? 'No matching user or group. Enter a full email to add a user.' : 'No users or groups found.'}</CommandEmpty>
            {typedIsNew && (
              <>
                <CommandGroup heading="Use typed email">
                  <CommandItem value={`__typed__ ${typed}`} onSelect={() => pick({ name: typed.toLowerCase(), type: 'user' })}>
                    <CornerDownLeft className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{typed.toLowerCase()}</span>
                  </CommandItem>
                </CommandGroup>
                <CommandSeparator />
              </>
            )}
            {users.length > 0 && (
              <CommandGroup heading={`Users · ${users.length}`}>
                {users.map((u) => {
                  const selected = value?.type === 'user' && value.name.toLowerCase() === u.userName.toLowerCase();
                  return (
                    <CommandItem
                      key={`u:${u.userName}`}
                      value={`user ${u.userName} ${u.displayName ?? ''}`}
                      onSelect={() => pick({ name: u.userName.toLowerCase(), type: 'user' })}
                    >
                      <Check className={cn('mr-2 h-4 w-4 shrink-0 text-brand', selected ? 'opacity-100' : 'opacity-0')} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{u.displayName || u.userName}</span>
                        {u.displayName && u.displayName !== u.userName && (
                          <span className="block truncate text-xs text-muted-foreground">{u.userName}</span>
                        )}
                      </span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
            {groups.length > 0 && (
              <CommandGroup heading={`Groups · ${groups.length}`}>
                {groups.map((g) => {
                  const selected = value?.type === 'group' && value.name.toLowerCase() === g.displayName.toLowerCase();
                  return (
                    <CommandItem key={`g:${g.displayName}`} value={`group ${g.displayName}`} onSelect={() => pick({ name: g.displayName, type: 'group' })}>
                      <Check className={cn('mr-2 h-4 w-4 shrink-0 text-brand', selected ? 'opacity-100' : 'opacity-0')} />
                      <Users className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{g.displayName}</span>
                      {g.workspaceLocal && (
                        <span
                          className="ml-auto shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[0.6875rem] font-semibold text-muted-foreground"
                          title="Workspace-local group: gets app/Genie/endpoint access, but Unity Catalog grants need an account-level group."
                        >
                          Workspace group
                        </span>
                      )}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
