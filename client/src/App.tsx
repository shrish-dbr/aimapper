import { createBrowserRouter, RouterProvider, NavLink, Outlet, useLocation } from 'react-router';
import { useState, useEffect } from 'react';
import {
  Button,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  useIsMobile,
} from '@databricks/appkit-ui/react';
import { Menu, Waypoints, History, BookOpen, LayoutGrid, ShieldCheck, ClipboardCheck, SlidersHorizontal, Folder, Info, type LucideIcon } from 'lucide-react';
import { DashboardPage } from './pages/aimapper/DashboardPage';
import { ProjectsPage } from './pages/aimapper/ProjectsPage';
import { AboutPage } from './pages/aimapper/AboutPage';
import { MapperPage } from './pages/aimapper/MapperPage';
import { HistoryPage } from './pages/aimapper/HistoryPage';
import { ReferencesPage } from './pages/aimapper/ReferencesPage';
import { AdminPage } from './pages/aimapper/AdminPage';
import { ApprovalsPage } from './pages/aimapper/ApprovalsPage';
import { SettingsPage } from './pages/aimapper/SettingsPage';
import { RoleProvider, useRole } from './lib/roleContext';
import { api } from './lib/aimapperApi';
import { displayName, initials } from './lib/display';
import { TopProgressBar } from './components/TopProgressBar';
import { ActivityTray } from './components/ActivityTray';
import { GenieAssistant } from './components/GenieAssistant';

interface NavItem { to: string; label: string; icon: LucideIcon; end: boolean; adminOnly: boolean; badge?: 'approvals' }

const NAV_SECTIONS: { title: string; items: NavItem[] }[] = [
  {
    title: 'Workspace',
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutGrid, end: true, adminOnly: false },
      { to: '/projects', label: 'Projects', icon: Folder, end: false, adminOnly: false },
      { to: '/mapper', label: 'Mapper', icon: Waypoints, end: false, adminOnly: false },
      { to: '/approvals', label: 'Approvals', icon: ClipboardCheck, end: false, adminOnly: false, badge: 'approvals' },
      { to: '/history', label: 'History', icon: History, end: false, adminOnly: false },
    ],
  },
  {
    title: 'Knowledge',
    items: [
      { to: '/references', label: 'References', icon: BookOpen, end: false, adminOnly: false },
      { to: '/admin', label: 'Admin', icon: ShieldCheck, end: false, adminOnly: true },
    ],
  },
];

const FOOTER_NAV: NavItem[] = [
  { to: '/about', label: 'About', icon: Info, end: false, adminOnly: false },
  { to: '/settings', label: 'Settings', icon: SlidersHorizontal, end: false, adminOnly: false },
];

const ROLE_LABEL: Record<string, string> = { viewer: 'Viewer', editor: 'Editor', admin: 'Admin' };

/** Count of mappings awaiting review, for the Approvals nav badge. Refreshes on
 * navigation so it reflects approve/reject actions taken elsewhere. */
function useInReviewCount(): number | null {
  const { pathname } = useLocation();
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .history('', 'in_review')
      .then((r) => { if (!cancelled) setCount(r.rows.length); })
      .catch(() => { if (!cancelled) setCount(null); });
    return () => { cancelled = true; };
  }, [pathname]);
  return count;
}

function SidebarLink({ item, onNavigate, badge }: { item: NavItem; onNavigate?: () => void; badge?: number | null }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onNavigate}
      className={({ isActive }) =>
        `group flex items-center gap-3 rounded-[0.625rem] px-3 py-2.5 text-[0.9375rem] font-medium ${
          isActive ? 'bg-ink-2 text-white font-semibold' : 'text-ink-foreground/80 hover:bg-white/5 hover:text-white'
        }`
      }
    >
      {({ isActive }) => (
        <>
          <Icon className={`h-[1.125rem] w-[1.125rem] shrink-0 ${isActive ? 'text-brand' : 'text-ink-muted group-hover:text-white'}`} strokeWidth={1.75} />
          <span className="flex-1 truncate">{item.label}</span>
          {badge ? (
            <span className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-brand px-1.5 text-[0.6875rem] font-bold text-white">
              {badge}
            </span>
          ) : null}
        </>
      )}
    </NavLink>
  );
}

/** Left sidebar contents — brand, signed-in user, sectioned nav, footer. Shared by
 * the desktop rail and the mobile slide-over sheet. */
function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const { isAdmin, role, email, loading } = useRole();
  const inReview = useInReviewCount();
  return (
    <div className="flex flex-col h-full">
      {/* Brand */}
      <div className="px-5 pt-6 pb-5 flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[0.625rem] bg-brand">
          <Waypoints className="h-5 w-5 text-white" strokeWidth={2} />
        </div>
        <div className="min-w-0">
          <p className="text-[1.0625rem] font-bold leading-tight text-white truncate">AI Mapper</p>
          <p className="text-xs text-ink-muted truncate">Target mapping studio</p>
        </div>
      </div>

      {/* Signed-in user */}
      <div className="px-3.5">
        <div className="flex items-center gap-3 rounded-xl bg-ink-2 px-3 py-3 min-h-[3.5rem]">
          {!loading && (
            <>
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-xs font-bold text-ink">{initials(email)}</span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-white truncate" title={email ?? undefined}>{displayName(email)}</p>
                <p className="text-xs text-ink-muted">{ROLE_LABEL[role] ?? role}</p>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Primary navigation */}
      <nav className="flex-1 overflow-y-auto px-3.5 pt-6 pb-4 space-y-6">
        {NAV_SECTIONS.map((section) => {
          const items = section.items.filter((n) => !n.adminOnly || isAdmin);
          if (items.length === 0) return null;
          return (
            <div key={section.title}>
              <p className="px-3 pb-2 text-[0.6875rem] font-semibold uppercase tracking-[0.1em] text-ink-muted">{section.title}</p>
              <div className="space-y-0.5">
                {items.map((item) => (
                  <SidebarLink key={item.to} item={item} onNavigate={onNavigate} badge={item.badge === 'approvals' ? inReview : undefined} />
                ))}
              </div>
            </div>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="mx-3.5 border-t border-white/10 py-4 space-y-0.5">
        {FOOTER_NAV.map((item) => (
          <SidebarLink key={item.to} item={item} onNavigate={onNavigate} />
        ))}
      </div>
    </div>
  );
}

function Layout() {
  const isMobile = useIsMobile();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => {
    // Close the mobile nav when the viewport grows to desktop (viewport-sync).
    if (isMobile) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMobileNavOpen(false);
  }, [isMobile]);

  return (
    <div className="min-h-screen bg-background flex">
      <TopProgressBar />
      <ActivityTray />

      {/* Desktop left sidebar */}
      <aside className="hidden md:flex w-[16.25rem] shrink-0 flex-col bg-ink text-ink-foreground sticky top-0 h-screen">
        <SidebarContent />
      </aside>

      <div className="flex-1 min-w-0 flex flex-col">
        {/* Mobile top bar with slide-over sidebar */}
        <header className="md:hidden flex items-center gap-3 px-4 py-3 bg-ink text-white sticky top-0 z-10">
          <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
            <Button variant="ghost" size="icon" className="text-white hover:bg-white/10 hover:text-white" onClick={() => setMobileNavOpen(true)}>
              <Menu className="h-5 w-5" />
              <span className="sr-only">Open navigation</span>
            </Button>
            <SheetContent side="left" className="p-0 w-[16.25rem] border-none bg-ink text-ink-foreground">
              <SheetHeader className="sr-only"><SheetTitle>Navigation</SheetTitle></SheetHeader>
              <SidebarContent onNavigate={() => setMobileNavOpen(false)} />
            </SheetContent>
          </Sheet>
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand"><Waypoints className="h-4 w-4 text-white" /></span>
            <span className="text-sm font-bold">AI Mapper</span>
          </div>
        </header>

        <main className="flex-1 px-4 py-6 md:px-12 md:py-10 w-full max-w-[1440px]">
          <Outlet />
        </main>
      </div>

      {/* Floating Ask Genie button + chat, available on every page. */}
      <GenieAssistant />
    </div>
  );
}

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <DashboardPage /> },
      { path: '/projects', element: <ProjectsPage /> },
      { path: '/mapper', element: <MapperPage /> },
      { path: '/approvals', element: <ApprovalsPage /> },
      { path: '/history', element: <HistoryPage /> },
      { path: '/references', element: <ReferencesPage /> },
      { path: '/admin', element: <AdminPage /> },
      { path: '/about', element: <AboutPage /> },
      { path: '/settings', element: <SettingsPage /> },
    ],
  },
]);

export default function App() {
  return (
    <RoleProvider>
      <RouterProvider router={router} />
    </RoleProvider>
  );
}
