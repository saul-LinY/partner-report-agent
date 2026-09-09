import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut } from "lucide-react";
import { Link, Redirect, Route, Switch, useLocation } from "wouter";
import { api } from "./api.js";
import { ErrorBanner } from "./components.js";
import { Login } from "./auth-pages.js";
import { AdminConsole } from "./admin.js";
import { ReviewPage } from "./review.js";
import { FactPreviewPage } from "./facts.js";
import { TeamReportPage } from "./team-reports.js";
import { ReviewQueuePage } from "./review-queue.js";
import { ReportArchivePage } from "./report-archive.js";
import { AgentJobsPage } from "./agent-jobs.js";
import { PluginMonitoringPage } from "./plugin-logs.js";
import { SystemMonitoringPage } from "./system-monitoring.js";
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
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">PR</div>
          <div>
            <strong>Partner Report</strong>
            <span>{me.teamName}</span>
          </div>
        </div>
        <nav aria-label="主导航">
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
                      href={href}
                    >
                      <Icon size={18} />
                      {label}
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
          <Route path="/admin/facts">
            <FactPreviewPage />
          </Route>
          <Route path="/admin/jobs">
            <AgentJobsPage />
          </Route>
          <Route path="/admin/plugin-logs">
            <PluginMonitoringPage />
          </Route>
          <Route path="/admin/system-monitoring">
            <SystemMonitoringPage />
          </Route>
          <Route path="/admin/team-reports/:id">
            <TeamReportPage />
          </Route>
          <Route path="/admin/reports">
            <ReportArchivePage />
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
