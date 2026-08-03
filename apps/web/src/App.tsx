import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Blocks,
  ClipboardCheck,
  FileText,
  LayoutDashboard,
  LogOut,
  RefreshCw,
  Settings,
  ShieldCheck,
  Users,
} from "lucide-react";
import { Link, Redirect, Route, Switch, useLocation } from "wouter";
import { api } from "./api.js";
import { Button, EmptyState, ErrorBanner } from "./components.js";
import { AcceptInvite, ConnectPlugin, Login } from "./auth-pages.js";
import { AdminConsole } from "./admin.js";
import { PartnerDashboard } from "./partner.js";
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
  const [location] = useLocation();
  const meQuery = useQuery({
    queryKey: ["me"],
    queryFn: () => api<Me>("/v1/me"),
    retry: false,
    enabled: !location.startsWith("/accept-invite"),
  });

  if (location.startsWith("/accept-invite")) return <AcceptInvite />;
  if (meQuery.isLoading)
    return (
      <div className="app-loading">
        <div className="brand-mark">PR</div>
        <span>加载工作区</span>
      </div>
    );
  if (meQuery.isError) return <Login onSuccess={() => meQuery.refetch()} />;
  if (!meQuery.data) return null;
  return <AuthenticatedApp me={meQuery.data} />;
}

function AuthenticatedApp({ me }: { me: Me }) {
  const [location, navigate] = useLocation();
  const queryClient = useQueryClient();
  const [workspace, setWorkspace] = useState<"partner" | "admin">(() =>
    location.startsWith("/admin") ? "admin" : "partner",
  );
  const [adminSection, setAdminSection] = useState(
    () => window.location.hash.slice(1) || "fleet",
  );
  const logout = useMutation({
    mutationFn: () => api("/v1/auth/logout", { method: "POST" }),
    onSuccess: () => {
      queryClient.clear();
      navigate("/");
    },
  });

  useEffect(() => {
    if (location.startsWith("/admin")) setWorkspace("admin");
    if (location.startsWith("/partner")) setWorkspace("partner");
  }, [location]);

  useEffect(() => {
    const syncAdminSection = () =>
      setAdminSection(window.location.hash.slice(1) || "fleet");
    syncAdminSection();
    window.addEventListener("hashchange", syncAdminSection);
    window.addEventListener("popstate", syncAdminSection);
    return () => {
      window.removeEventListener("hashchange", syncAdminSection);
      window.removeEventListener("popstate", syncAdminSection);
    };
  }, [location]);

  const switchWorkspace = (next: "partner" | "admin") => {
    setWorkspace(next);
    navigate(next === "admin" ? "/admin" : "/partner");
  };

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
        <div className="workspace-switch" role="group" aria-label="工作区">
          {me.roles.includes("partner") && (
            <button
              className={workspace === "partner" ? "active" : ""}
              onClick={() => switchWorkspace("partner")}
            >
              Partner
            </button>
          )}
          {me.roles.includes("admin") && (
            <button
              className={workspace === "admin" ? "active" : ""}
              onClick={() => switchWorkspace("admin")}
            >
              Admin
            </button>
          )}
        </div>
        <nav>
          {workspace === "partner" ? (
            <>
              <Link
                className={location === "/partner" ? "active" : ""}
                href="/partner"
              >
                <LayoutDashboard size={18} />
                当前周期
              </Link>
              <Link
                className={
                  location.startsWith("/partner/review") ? "active" : ""
                }
                href="/partner/review"
              >
                <ClipboardCheck size={18} />
                项目卡片审核
              </Link>
              <Link
                className={
                  location.startsWith("/partner/report") ? "active" : ""
                }
                href="/partner/report"
              >
                <FileText size={18} />
                周报审核
              </Link>
              <Link
                className={location === "/connect-plugin" ? "active" : ""}
                href="/connect-plugin"
              >
                <Blocks size={18} />
                连接 Plugin
              </Link>
            </>
          ) : (
            <>
              <a
                className={adminSection === "fleet" ? "active" : ""}
                href="/admin#fleet"
              >
                <Activity size={18} />
                Plugin Fleet
              </a>
              <a
                className={adminSection === "partners" ? "active" : ""}
                href="/admin#partners"
              >
                <Users size={18} />
                Partner
              </a>
              <a
                className={adminSection === "projects" ? "active" : ""}
                href="/admin#projects"
              >
                <Settings size={18} />
                项目与策略
              </a>
              <a
                className={adminSection === "audit" ? "active" : ""}
                href="/admin#audit"
              >
                <ShieldCheck size={18} />
                审计
              </a>
            </>
          )}
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
          <Route path="/partner/review">
            <CurrentPartnerResource kind="review" />
          </Route>
          <Route path="/partner/report/:reportId">
            <ReportPage />
          </Route>
          <Route path="/partner/report">
            <CurrentPartnerResource kind="report" />
          </Route>
          <Route path="/partner/progress">
            <Redirect to="/partner/review" replace />
          </Route>
          <Route path="/partner">
            <PartnerDashboard me={me} />
          </Route>
          <Route path="/connect-plugin">
            <ConnectPlugin />
          </Route>
          <Route path="/admin">
            <AdminConsole />
          </Route>
          <Route>
            <Redirect
              to={me.roles.includes("partner") ? "/partner" : "/admin"}
              replace
            />
          </Route>
        </Switch>
      </main>
    </div>
  );
}

type PartnerResourceDashboard = {
  review: { id: string } | null;
  report: { id: string } | null;
};

function CurrentPartnerResource({ kind }: { kind: "review" | "report" }) {
  const query = useQuery({
    queryKey: ["partner-dashboard"],
    queryFn: () => api<PartnerResourceDashboard>("/v1/partner/dashboard"),
  });
  if (query.isLoading)
    return (
      <div className="page-loading">
        <RefreshCw className="spin" />
        加载当前周期
      </div>
    );
  if (query.isError)
    return (
      <div className="page">
        <ErrorBanner error={query.error} />
      </div>
    );
  const id = query.data?.[kind]?.id;
  if (id) return <Redirect to={`/partner/${kind}/${id}`} replace />;
  return (
    <div className="page">
      <EmptyState
        title={
          kind === "review"
            ? "当前周期还没有事项审核"
            : "当前周期还没有个人 Report"
        }
        action={
          <Link className="button button-secondary" href="/partner">
            返回当前周期
          </Link>
        }
      />
    </div>
  );
}
