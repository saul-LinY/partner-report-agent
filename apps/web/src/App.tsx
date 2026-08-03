import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardCheck, FolderKanban, LayoutDashboard, LogOut, Users } from "lucide-react";
import { Link, Redirect, Route, Switch, useLocation } from "wouter";
import { api } from "./api.js";
import { ErrorBanner } from "./components.js";
import { Login } from "./auth-pages.js";
import { AdminConsole } from "./admin.js";
import { ReviewPage } from "./review.js";
import { ReportPage } from "./report.js";

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
  if (meQuery.isLoading) return <div className="app-loading"><div className="brand-mark">PR</div><span>加载管理台</span></div>;
  if (meQuery.isError) return <Login onSuccess={() => meQuery.refetch()} />;
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
  const reviewing = location.startsWith("/partner/review") || location.startsWith("/partner/report");

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">PR</div><div><strong>Partner Report</strong><span>{me.teamName}</span></div></div>
      <nav>
        <Link className={location === "/admin" ? "active" : ""} href="/admin"><LayoutDashboard size={18} />运行总览</Link>
        <Link className={reviewing ? "active" : ""} href="/admin"><ClipboardCheck size={18} />审核队列</Link>
        <Link className={location === "/admin/partners" ? "active" : ""} href="/admin/partners"><Users size={18} />Partner 与绑定</Link>
        <Link className={location === "/admin/projects" ? "active" : ""} href="/admin/projects"><FolderKanban size={18} />项目目录</Link>
      </nav>
      <div className="sidebar-user"><div><strong>{me.displayName}</strong><span>{me.email}</span></div><button className="icon-button" title="退出" onClick={() => logout.mutate()}><LogOut size={17} /></button></div>
    </aside>
    <main className="main-content">
      <ErrorBanner error={logout.error} />
      <Switch>
        <Route path="/partner/review/:reviewId"><ReviewPage /></Route>
        <Route path="/partner/report/:reportId"><ReportPage /></Route>
        <Route path="/admin/partners"><AdminConsole section="partners" /></Route>
        <Route path="/admin/projects"><AdminConsole section="projects" /></Route>
        <Route path="/admin"><AdminConsole section="overview" /></Route>
        <Route><Redirect to="/admin" replace /></Route>
      </Switch>
    </main>
  </div>;
}
