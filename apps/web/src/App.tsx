import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Link, Redirect, Route, Switch, useLocation } from "wouter";
import { api } from "./api.js";
import { ErrorBanner } from "./components.js";
import { Login } from "./auth-pages.js";
import { AdminConsole, TeamSettingsPage } from "./admin.js";
import { ReviewPage } from "./review.js";
import { SessionPreprocessPage } from "./preprocess.js";
import { MemberDetailPage } from "./member-detail.js";
import { ReviewQueuePage } from "./review-queue.js";
import { ReportArchivePage } from "./report-archive.js";
import { UserLogsPage } from "./user-logs.js";
import { SystemLogsPage } from "./system-logs.js";
import { InspectionPage } from "./inspection.js";
import { isNavigationActive, navigationGroups } from "./navigation.js";

export type Me = {
  userId: string;
  tenantId: string;
  teamId: string;
  partnerId: string | null;
  roles: string[];
  email: string;
  displayName: string;
  teamName: string;
  partnerName: string | null;
};

export function App() {
  const meQuery = useQuery({
    queryKey: ["me"],
    queryFn: () => api<Me>("/v1/me"),
    retry: false,
  });
  if (meQuery.isLoading)
    return (
      <div className="app-loading">
        <div className="brand-mark">PR</div>
        <span>加载管理台</span>
      </div>
    );
  if (meQuery.isError) {
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (!window.location.pathname.startsWith("/login")) {
      window.history.replaceState(
        null,
        "",
        `/login?next=${encodeURIComponent(current)}`,
      );
    }
    return <Login onSuccess={() => meQuery.refetch()} />;
  }
  if (!meQuery.data) return null;
  return <AuthenticatedApp me={meQuery.data} />;
}

function AuthenticatedApp({ me }: { me: Me }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return (
        window.localStorage.getItem("partner-report-sidebar-collapsed") ===
        "true"
      );
    } catch {
      return false;
    }
  });
  const toggleSidebar = () => {
    const collapsed = !sidebarCollapsed;
    setSidebarCollapsed(collapsed);
    try {
      window.localStorage.setItem(
        "partner-report-sidebar-collapsed",
        String(collapsed),
      );
    } catch {
      // Keep the toggle usable when browser storage is unavailable.
    }
  };
  const [location, navigate] = useLocation();
  const queryClient = useQueryClient();
  const logout = useMutation({
    mutationFn: () => api("/v1/auth/logout", { method: "POST" }),
    onSuccess: () => {
      window.localStorage.removeItem("partner-report-simulated-partner");
      queryClient.clear();
      navigate("/");
    },
  });

  return (
    <div className={`app-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="sidebar-heading">
          <div className="brand">
            <img
              className="brand-mark"
              src="/app-icon.png"
              alt="Weekly Report"
            />
            <div className="brand-copy">
              <strong>Weekly Report</strong>
              <span>{me.teamName}</span>
            </div>
          </div>
          <button
            type="button"
            className="sidebar-toggle"
            aria-label={sidebarCollapsed ? "展开导航栏" : "收拢导航栏"}
            title={sidebarCollapsed ? "展开导航栏" : "收拢导航栏"}
            aria-expanded={!sidebarCollapsed}
            aria-controls="main-navigation"
            onClick={toggleSidebar}
          >
            {sidebarCollapsed ? (
              <PanelLeftOpen size={18} />
            ) : (
              <PanelLeftClose size={18} />
            )}
          </button>
        </div>
        <nav id="main-navigation" aria-label="主导航">
          {navigationGroups.map((group) => (
            <div className="nav-group" key={group.label}>
              <span className="nav-group-label">{group.label}</span>
              <div className="nav-group-links">
                {group.items.map(({ label, href, icon: Icon }) => {
                  const active = isNavigationActive(location, href);
                  return (
                    <Link
                      key={href}
                      className={active ? "active" : ""}
                      aria-current={active ? "page" : undefined}
                      aria-label={label}
                      title={label}
                      href={href}
                    >
                      <Icon size={18} />
                      <span className="nav-item-label">{label}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
        <div className="sidebar-user">
          <div>
            <strong>{me.displayName}</strong>
            <span>{me.email}</span>
          </div>
          <button
            className="icon-button"
            title="退出"
            onClick={() => logout.mutate()}
          >
            <LogOut size={17} />
          </button>
        </div>
      </aside>
      <main className="main-content">
        <ErrorBanner error={logout.error} />
        <Switch>
          <Route path="/partner/review/:reviewId">
            <ReviewPage />
          </Route>
          <Route path="/admin/reviews">
            <ReviewQueuePage />
          </Route>
          <Route path="/admin/sessions">
            <SessionPreprocessPage />
          </Route>
          <Route path="/admin/members/:id">
            <MemberDetailPage />
          </Route>
          <Route path="/admin/preprocess">
            <Redirect to="/admin/sessions" replace />
          </Route>
          <Route path="/admin/user-logs">
            <UserLogsPage />
          </Route>
          <Route path="/admin/system-logs">
            <SystemLogsPage />
          </Route>
          <Route path="/admin/inspection">
            <InspectionPage />
          </Route>
          <Route path="/admin/jobs">
            <Redirect to="/admin/inspection" replace />
          </Route>
          <Route path="/admin/system-monitoring">
            <Redirect to="/admin/system-logs" replace />
          </Route>
          <Route path="/admin/reports">
            <ReportArchivePage />
          </Route>
          <Route path="/admin/team-settings">
            <TeamSettingsPage />
          </Route>
          <Route path="/admin">
            <AdminConsole />
          </Route>
          <Route>
            <Redirect to="/admin" replace />
          </Route>
        </Switch>
      </main>
    </div>
  );
}
