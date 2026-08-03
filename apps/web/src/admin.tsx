import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Ban, CalendarRange, CircleDot, Clock3, FileText, FolderKanban, Plus, RefreshCw, RotateCcw, Save, ShieldCheck, UserCheck, Users } from "lucide-react";
import { api } from "./api.js";
import { Badge, Button, EmptyState, ErrorBanner, Field, Modal, SuccessBanner } from "./components.js";

type Overview = {
  team: any;
  projects: any[];
  partners: any[];
  templates: any[];
  periods: any[];
  plugins: any[];
  jobs: any[];
  auditEvents: any[];
};

const healthTone: Record<string, string> = { healthy: "success", delayed: "warning", offline: "danger", blocked: "neutral" };

export function AdminConsole() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["admin-overview"], queryFn: () => api<Overview>("/v1/admin/overview"), refetchInterval: 15_000 });
  const [projectModal, setProjectModal] = useState(false);
  const [inviteModal, setInviteModal] = useState(false);
  const [templateModal, setTemplateModal] = useState(false);
  const [periodModal, setPeriodModal] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!query.isSuccess) return;
    const scrollToSection = () => {
      const sectionId = window.location.hash.slice(1);
      if (sectionId) document.getElementById(sectionId)?.scrollIntoView({ block: "start" });
    };
    const frame = window.requestAnimationFrame(scrollToSection);
    window.addEventListener("hashchange", scrollToSection);
    window.addEventListener("popstate", scrollToSection);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("hashchange", scrollToSection);
      window.removeEventListener("popstate", scrollToSection);
    };
  }, [query.isSuccess]);

  if (query.isLoading) return <div className="page-loading"><RefreshCw className="spin" />加载 Admin Console</div>;
  if (query.isError) return <div className="page"><ErrorBanner error={query.error} /></div>;
  const data = query.data!;
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["admin-overview"] });
  return (
    <div className="page">
      <header className="page-header"><div><span className="eyebrow">ADMIN WORKSPACE</span><h1>Plugin Fleet</h1><p>{data.team?.name}</p></div><Button variant="secondary" icon={<RefreshCw size={16} />} onClick={() => query.refetch()}>刷新</Button></header>
      {message && <SuccessBanner>{message}</SuccessBanner>}
      <section className="admin-summary">
        <Summary icon={<Activity />} label="活动实例" value={data.plugins.filter((plugin) => plugin.status === "active").length} />
        <Summary icon={<Users />} label="Partner" value={data.partners.length} />
        <Summary icon={<Clock3 />} label="待处理任务" value={data.jobs.filter((job) => !["COMPLETED", "FAILED", "CANCELLED"].includes(job.status)).reduce((sum, job) => sum + job.count, 0)} />
        <Summary icon={<ShieldCheck />} label="最低版本" value={data.team.minimum_plugin_version} text />
      </section>

      <section className="section-block" id="fleet">
        <div className="section-heading"><div><h2>实例状态</h2><p>心跳、同步、版本与任务健康</p></div></div>
        {data.plugins.length === 0 ? <EmptyState title="尚未绑定 Plugin Instance" /> : <div className="fleet-list">{data.plugins.map((plugin) => <PluginRow key={plugin.id} plugin={plugin} onChanged={invalidate} />)}</div>}
      </section>

      <div className="admin-grid">
        <section className="section-block" id="projects">
          <div className="section-heading"><div><h2>项目范围</h2><p>服务端项目映射不扩大本地授权</p></div><Button variant="secondary" icon={<Plus size={16} />} onClick={() => setProjectModal(true)}>新增</Button></div>
          <div className="project-list">{data.projects.map((project) => <div className="project-row" key={project.id}><span className="project-icon"><FolderKanban size={18} /></span><div><strong>{project.name}</strong><span>{(project.aliases ?? []).join(" · ") || "无别名"}</span></div><Badge>{project.status}</Badge></div>)}</div>
        </section>
        <TeamSettings team={data.team} onSaved={() => { invalidate(); setMessage("Team 策略已更新。"); }} />
      </div>

      <div className="admin-grid">
        <section className="section-block" id="periods">
          <div className="section-heading"><div><h2>报告周期</h2><p>按 Team 时区定义收集与截止边界</p></div><Button variant="secondary" icon={<Plus size={16} />} onClick={() => setPeriodModal(true)}>新增</Button></div>
          <div className="resource-list">{data.periods.map((period) => <PeriodRow key={period.id} period={period} onChanged={invalidate} />)}</div>
        </section>
        <section className="section-block" id="templates">
          <div className="section-heading"><div><h2>报告模板</h2><p>已使用版本不会原地修改</p></div><Button variant="secondary" icon={<Plus size={16} />} onClick={() => setTemplateModal(true)}>新增</Button></div>
          <div className="resource-list">{data.templates.map((template) => <div className="resource-row" key={template.id}><span className="resource-icon"><FileText size={17} /></span><div><strong>{template.name}</strong><span>v{template.version} · {(template.sections ?? []).length} 个章节</span></div>{template.is_default && <Badge tone="success">默认</Badge>}</div>)}</div>
        </section>
      </div>

      <section className="section-block" id="partners">
        <div className="section-heading"><div><h2>Partner 账号</h2><p>邀请链接有效期 48 小时</p></div><Button variant="secondary" icon={<Plus size={16} />} onClick={() => setInviteModal(true)}>创建邀请</Button></div>
        <div className="resource-list">{data.partners.map((partner) => <div className="resource-row" key={partner.id}><span className="resource-icon partner-icon"><UserCheck size={17} /></span><div><strong>{partner.display_name}</strong><span>{partner.email ?? "尚未绑定账号"} · {(partner.roles ?? []).join(" / ") || "无角色"}</span></div><Badge tone={partner.status === "active" ? "success" : "neutral"}>{partner.status}</Badge></div>)}</div>
      </section>

      <section className="section-block" id="audit">
        <div className="section-heading"><div><h2>审计事件</h2><p>仅记录主体、动作、资源与安全元数据</p></div></div>
        <div className="audit-list">{data.auditEvents.map((event) => <div key={event.id} className="audit-row"><CircleDot size={14} /><div><strong>{event.action}</strong><span>{event.actor_type} · {event.target_type}</span></div><time>{new Date(event.created_at).toLocaleString("zh-CN")}</time></div>)}</div>
      </section>

      {projectModal && <ProjectModal onClose={() => setProjectModal(false)} onCreated={() => { setProjectModal(false); invalidate(); setMessage("项目已创建。"); }} />}
      {inviteModal && <InviteModal onClose={() => setInviteModal(false)} />}
      {templateModal && <TemplateModal onClose={() => setTemplateModal(false)} onCreated={() => { setTemplateModal(false); invalidate(); setMessage("报告模板已创建。"); }} />}
      {periodModal && <PeriodModal templates={data.templates} timezone={data.team.timezone} onClose={() => setPeriodModal(false)} onCreated={() => { setPeriodModal(false); invalidate(); setMessage("报告周期已创建。"); }} />}
    </div>
  );
}

function PeriodRow({ period, onChanged }: { period: any; onChanged: () => void }) {
  const update = useMutation({ mutationFn: () => api(`/v1/admin/report-periods/${period.id}`, { method: "PATCH", body: JSON.stringify({ status: period.status === "open" ? "closed" : "open" }) }), onSuccess: onChanged });
  return <div className="resource-row"><span className="resource-icon"><CalendarRange size={17} /></span><div><strong>{period.period_key}</strong><span>{new Date(period.starts_at).toLocaleDateString("zh-CN")} - {new Date(period.ends_at).toLocaleDateString("zh-CN")} · {period.timezone}</span></div><Badge tone={period.status === "open" ? "success" : "neutral"}>{period.status}</Badge><button className="icon-button" title={period.status === "open" ? "关闭周期" : "重新开放"} disabled={update.isPending} onClick={() => update.mutate()}><RotateCcw size={16} /></button></div>;
}

function Summary({ icon, label, value, text }: { icon: ReactNode; label: string; value: number | string; text?: boolean }) {
  return <div className="summary-cell"><span className="summary-icon">{icon}</span><div><span>{label}</span><strong className={text ? "summary-text" : ""}>{value}</strong></div></div>;
}

function PluginRow({ plugin, onChanged }: { plugin: any; onChanged: () => void }) {
  const rescan = useMutation({ mutationFn: () => api(`/v1/admin/plugin-instances/${plugin.id}/rescan`, { method: "POST" }), onSuccess: onChanged });
  const revoke = useMutation({ mutationFn: () => api(`/v1/admin/plugin-instances/${plugin.id}`, { method: "DELETE" }), onSuccess: onChanged });
  return <div className="fleet-entry"><div className="fleet-row">
      <div className={`health-dot health-${plugin.health}`} />
      <div className="fleet-primary"><strong>{plugin.partner_name}</strong><span>{plugin.device_name} · v{plugin.version}</span></div>
      <div><span className="cell-label">健康</span><Badge tone={healthTone[plugin.health]}>{plugin.health}</Badge></div>
      <div><span className="cell-label">最后心跳</span><strong>{plugin.last_heartbeat_at ? relativeTime(plugin.last_heartbeat_at) : "从未"}</strong></div>
      <div><span className="cell-label">最后同步</span><strong>{plugin.last_sync_at ? relativeTime(plugin.last_sync_at) : "从未"}</strong></div>
      <div><span className="cell-label">本地待办</span><strong>{plugin.pending_local_jobs}</strong></div>
      <div className="fleet-actions"><button className="icon-button" title="请求重新扫描" onClick={() => rescan.mutate()} disabled={rescan.isPending}><RotateCcw size={17} /></button><button className="icon-button danger" title="撤销绑定" onClick={() => revoke.mutate()} disabled={revoke.isPending || plugin.status !== "active"}><Ban size={17} /></button></div>
    </div><div className="fleet-detail">
      <div><span>绑定</span><strong>{plugin.status}</strong></div>
      <div><span>最后扫描</span><strong>{plugin.last_scan_at ? relativeTime(plugin.last_scan_at) : "从未"}</strong></div>
      <div><span>Runner</span><strong>{plugin.runner_state ?? "unknown"}</strong></div>
      <div><span>最后 Runner</span><strong>{plugin.last_runner_at ? relativeTime(plugin.last_runner_at) : "从未"}</strong></div>
      <div><span>最后 Hook</span><strong>{plugin.last_hook_at ? relativeTime(plugin.last_hook_at) : "从未"}</strong></div>
      <div><span>下次到期</span><strong>{plugin.next_due_at ? relativeDeadline(plugin.next_due_at) : "--"}</strong></div>
      <div><span>待静默</span><strong>{plugin.dirty_sessions ?? 0}</strong></div>
      <div><span>提取中</span><strong>{plugin.extracting_sessions ?? 0}</strong></div>
      <div><span>Coverage</span><strong>{plugin.coverage ? `${plugin.coverage.extracted}/${plugin.coverage.discovered}` : "--"}</strong></div>
      <div><span>服务端待办</span><strong>{plugin.pending_agent_jobs}</strong></div>
      <div><span>重试</span><strong>{plugin.retry_count}</strong></div>
      <div><span>安全错误码</span><code>{plugin.last_error_code ?? "--"}</code></div>
    </div></div>;
}

function relativeTime(value: string) {
  const hours = Math.round((Date.now() - new Date(value).getTime()) / 3_600_000);
  if (hours < 1) return "刚刚";
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

function relativeDeadline(value: string) {
  const minutes = Math.round((new Date(value).getTime() - Date.now()) / 60_000);
  if (minutes <= 0) return "已到期";
  if (minutes < 60) return `${minutes} 分钟后`;
  return `${Math.round(minutes / 60)} 小时后`;
}

function TeamSettings({ team, onSaved }: { team: any; onSaved: () => void }) {
  const [name, setName] = useState(team.name);
  const [timezone, setTimezone] = useState(team.timezone);
  const [minimumPluginVersion, setMinimumPluginVersion] = useState(team.minimum_plugin_version);
  const [sessionQuietPeriodMinutes, setSessionQuietPeriodMinutes] = useState(team.session_quiet_period_minutes ?? 120);
  const [evidenceExcerptEnabled, setEvidenceExcerptEnabled] = useState(team.evidence_excerpt_enabled);
  const save = useMutation({
    mutationFn: () => api("/v1/admin/team", { method: "PATCH", body: JSON.stringify({ name, timezone, minimumPluginVersion, sessionQuietPeriodMinutes, evidenceExcerptEnabled }) }),
    onSuccess: onSaved
  });
  return <section className="section-block settings-block"><div className="section-heading"><div><h2>Team 策略</h2><p>未来周期与 Plugin 最低要求</p></div></div><form onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
    <ErrorBanner error={save.error} />
    <Field label="Team 名称"><input value={name} onChange={(event) => setName(event.target.value)} /></Field>
    <Field label="时区"><input value={timezone} onChange={(event) => setTimezone(event.target.value)} /></Field>
    <Field label="Session 静默窗口（分钟）" hint="默认 120 分钟；有新对话时重新计时"><input type="number" min={15} max={1440} value={sessionQuietPeriodMinutes} onChange={(event) => setSessionQuietPeriodMinutes(Number(event.target.value))} /></Field>
    <Field label="最低 Plugin 版本"><input value={minimumPluginVersion} onChange={(event) => setMinimumPluginVersion(event.target.value)} /></Field>
    <label className="toggle-row"><input type="checkbox" checked={evidenceExcerptEnabled} onChange={(event) => setEvidenceExcerptEnabled(event.target.checked)} /><span><strong>上传有限 Evidence 摘要</strong><small>最长 240 字符，完整 Session 始终留在本地</small></span></label>
    <Button type="submit" loading={save.isPending} icon={<Save size={16} />}>保存策略</Button>
  </form></section>;
}

function ProjectModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [aliases, setAliases] = useState("");
  const [paths, setPaths] = useState("");
  const create = useMutation({ mutationFn: () => api("/v1/admin/projects", { method: "POST", body: JSON.stringify({ name, aliases: aliases.split(",").map((v) => v.trim()).filter(Boolean), allowedPaths: paths.split("\n").map((v) => v.trim()).filter(Boolean), externalIds: [] }) }), onSuccess: onCreated });
  return <Modal title="新增项目" onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>取消</Button><Button loading={create.isPending} onClick={() => create.mutate()}>创建</Button></>}><ErrorBanner error={create.error} /><Field label="项目名称"><input value={name} onChange={(event) => setName(event.target.value)} autoFocus /></Field><Field label="别名" hint="用逗号分隔"><input value={aliases} onChange={(event) => setAliases(event.target.value)} /></Field><Field label="建议路径" hint="每行一个路径"><textarea value={paths} onChange={(event) => setPaths(event.target.value)} rows={4} /></Field></Modal>;
}

function InviteModal({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [inviteUrl, setInviteUrl] = useState("");
  const invite = useMutation({ mutationFn: () => api<{ inviteUrl: string }>("/v1/admin/invitations", { method: "POST", body: JSON.stringify({ email, roles: ["partner"] }) }), onSuccess: (data) => setInviteUrl(data.inviteUrl) });
  return <Modal title="邀请 Partner" onClose={onClose} footer={!inviteUrl ? <><Button variant="ghost" onClick={onClose}>取消</Button><Button loading={invite.isPending} onClick={() => invite.mutate()}>生成邀请</Button></> : <Button onClick={() => navigator.clipboard.writeText(inviteUrl)}>复制链接</Button>}><ErrorBanner error={invite.error} />{inviteUrl ? <Field label="邀请链接"><textarea readOnly value={inviteUrl} rows={4} /></Field> : <Field label="邮箱"><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoFocus /></Field>}</Modal>;
}

const defaultSections = ["本期摘要", "关键成果", "项目进展", "风险与阻塞", "下一期重点", "需协调事项", "数据覆盖"];

function TemplateModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("个人周报");
  const [sections, setSections] = useState(defaultSections.join("\n"));
  const [isDefault, setIsDefault] = useState(false);
  const create = useMutation({ mutationFn: () => api("/v1/admin/report-templates", { method: "POST", body: JSON.stringify({ name, sections: sections.split("\n").map((value) => value.trim()).filter(Boolean), isDefault }) }), onSuccess: onCreated });
  return <Modal title="新增报告模板" onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>取消</Button><Button loading={create.isPending} onClick={() => create.mutate()}>创建</Button></>}><ErrorBanner error={create.error} /><Field label="模板名称"><input value={name} onChange={(event) => setName(event.target.value)} autoFocus /></Field><Field label="章节" hint="固定 7 行，按输出顺序排列"><textarea value={sections} onChange={(event) => setSections(event.target.value)} rows={8} /></Field><label className="toggle-row"><input type="checkbox" checked={isDefault} onChange={(event) => setIsDefault(event.target.checked)} /><span><strong>设为默认模板</strong><small>新生成的个人 Report 将读取此版本</small></span></label></Modal>;
}

function localDateTime(date: Date) {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

function PeriodModal({ templates, timezone, onClose, onCreated }: { templates: any[]; timezone: string; onClose: () => void; onCreated: () => void }) {
  const now = new Date();
  const [periodKey, setPeriodKey] = useState("");
  const [startsAt, setStartsAt] = useState(localDateTime(now));
  const [endsAt, setEndsAt] = useState(localDateTime(new Date(now.getTime() + 7 * 86_400_000 - 1)));
  const [cutoffAt, setCutoffAt] = useState(localDateTime(new Date(now.getTime() + 7 * 86_400_000 - 1)));
  const [templateId, setTemplateId] = useState(templates.find((template) => template.is_default)?.id ?? templates[0]?.id ?? "");
  const create = useMutation({ mutationFn: () => api("/v1/admin/report-periods", { method: "POST", body: JSON.stringify({ periodKey, startsAt: new Date(startsAt).toISOString(), endsAt: new Date(endsAt).toISOString(), cutoffAt: new Date(cutoffAt).toISOString(), timezone, templateId: templateId || undefined, status: "open" }) }), onSuccess: onCreated });
  return <Modal title="新增报告周期" onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>取消</Button><Button loading={create.isPending} onClick={() => create.mutate()}>创建</Button></>}><ErrorBanner error={create.error} /><Field label="周期标识" hint="例如 2026-W32"><input value={periodKey} onChange={(event) => setPeriodKey(event.target.value)} autoFocus /></Field><div className="form-row"><Field label="开始时间"><input type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} /></Field><Field label="结束时间"><input type="datetime-local" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} /></Field></div><Field label="截止时间"><input type="datetime-local" value={cutoffAt} onChange={(event) => setCutoffAt(event.target.value)} /></Field><Field label="模板"><select value={templateId} onChange={(event) => setTemplateId(event.target.value)}>{templates.map((template) => <option value={template.id} key={template.id}>{template.name} v{template.version}</option>)}</select></Field><div className="inline-note"><Clock3 size={17} /><span>当前输入按浏览器本地时区转换；周期策略标记为 {timezone}。</span></div></Modal>;
}
