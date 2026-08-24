import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ClipboardCheck,
  FileStack,
  HeartPulse,
  LayoutDashboard,
  LogOut,
  PlugZap,
  TableProperties,
} from "lucide-react";
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
  const reviewing =
    location === "/admin/reviews" || location.startsWith("/partner/review");

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
        <nav>
          <Link
            className={
              location === "/admin" || location === "/admin/jobs"
                ? "active"
                : ""
            }
            href="/admin"
          >
            <LayoutDashboard size={18} />
            运行总览
          </Link>
          <Link className={reviewing ? "active" : ""} href="/admin/reviews">
            <ClipboardCheck size={18} />
            审核队列
          </Link>
          <Link
            className={location === "/admin/facts" ? "active" : ""}
            href="/admin/facts"
          >
            <TableProperties size={18} />
            贡献预览
          </Link>
          <Link
            className={
              location.startsWith("/admin/reports") ||
              location.startsWith("/admin/team-reports")
                ? "active"
                : ""
            }
            href="/admin/reports"
          >
            <FileStack size={18} />
            报告归档
          </Link>
          <Link
            className={location === "/admin/plugin-logs" ? "active" : ""}
            href="/admin/plugin-logs"
          >
            <PlugZap size={18} />
            插件监控
          </Link>
          <Link
            className={location === "/admin/system-monitoring" ? "active" : ""}
            href="/admin/system-monitoring"
          >
            <HeartPulse size={18} />
            系统监控
          </Link>
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
