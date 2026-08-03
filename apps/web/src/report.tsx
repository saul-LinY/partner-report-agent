import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, Download, FileClock, RefreshCw, RotateCcw, Send, SlidersHorizontal } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { useLocation, useRoute } from "wouter";
import { api, apiUrl } from "./api.js";
import { Badge, Button, EmptyState, ErrorBanner, Field, Modal } from "./components.js";

type ReportData = {
  report: any;
  current: any | null;
  versions: any[];
};

type Preferences = {
  length: "short" | "standard" | "detailed";
  language: "zh-CN" | "en-US";
  emphasis: string;
  technicalDetail: "low" | "medium" | "high";
};

const defaultPreferences: Preferences = {
  length: "standard",
  language: "zh-CN",
  emphasis: "",
  technicalDetail: "medium"
};

const statusLabels: Record<string, string> = {
  REPORT_DRAFT: "生成中",
  REPORT_REVIEW: "待审核",
  RETURNED_TO_ITEMS: "已退回事项层",
  SUBMITTED: "已提交",
  LOCKED: "已锁定"
};

export function ReportPage() {
  const [, params] = useRoute("/partner/report/:reportId");
  const reportId = params?.reportId ?? "";
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["report", reportId],
    queryFn: () => api<ReportData>(`/v1/individual-reports/${reportId}`),
    refetchInterval: (state) => state.state.data?.report.status === "REPORT_DRAFT" ? 4_000 : false
  });
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [preferences, setPreferences] = useState<Preferences>(defaultPreferences);

  useEffect(() => {
    if (!query.data?.current) return;
    setSelectedVersion((current) => current ?? query.data!.current.version);
    setPreferences({ ...defaultPreferences, ...(query.data.current.preferences ?? {}) });
  }, [query.data?.current?.version]);

  const regenerate = useMutation({
    mutationFn: () => api(`/v1/individual-reports/${reportId}/regenerate`, {
      method: "POST",
      body: JSON.stringify(preferences)
    }),
    onSuccess: async () => {
      setPreferencesOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["report", reportId] });
      await queryClient.invalidateQueries({ queryKey: ["partner-dashboard"] });
    }
  });
  const returnToItems = useMutation({
    mutationFn: () => api<{ reviewId: string }>(`/v1/individual-reports/${reportId}/return-to-items`, { method: "POST" }),
    onSuccess: (result) => navigate(`/partner/review/${result.reviewId}`)
  });
  const submit = useMutation({
    mutationFn: () => api(`/v1/individual-reports/${reportId}/submit`, {
      method: "POST",
      body: JSON.stringify({ baseVersion: query.data!.report.current_version })
    }),
    onSuccess: async () => {
      setSubmitOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["report", reportId] });
      await queryClient.invalidateQueries({ queryKey: ["partner-dashboard"] });
    }
  });

  if (query.isLoading) return <div className="page-loading"><RefreshCw className="spin" />加载 Report</div>;
  if (query.isError) return <div className="page"><ErrorBanner error={query.error} /></div>;
  const data = query.data!;
  const viewing = data.versions.find((version) => version.version === selectedVersion) ?? data.current;
  const isLocked = data.report.status === "LOCKED";
  const isCurrent = viewing?.version === data.report.current_version;

  return (
    <div className="page report-page">
      <header className="page-header report-header">
        <div>
          <span className="eyebrow">SECOND REVIEW</span>
          <h1>{viewing?.title ?? "个人 Report"}</h1>
          <p>{statusLabels[data.report.status] ?? data.report.status}{viewing ? ` · v${viewing.version}` : ""}</p>
        </div>
        <div className="header-actions">
          {!isLocked && <Button variant="secondary" icon={<ArrowLeft size={16} />} loading={returnToItems.isPending} onClick={() => returnToItems.mutate()}>事实有误，返回事项</Button>}
          {!isLocked && data.current && <Button variant="secondary" icon={<SlidersHorizontal size={16} />} onClick={() => setPreferencesOpen(true)}>调整表达</Button>}
          {!isLocked && data.report.status === "REPORT_REVIEW" && <Button icon={<Send size={16} />} onClick={() => setSubmitOpen(true)}>提交并锁定</Button>}
          {data.current && <a className="button button-secondary" href={apiUrl(`/v1/individual-reports/${reportId}/download.md`)}><Download size={16} /><span>Markdown</span></a>}
        </div>
      </header>
      <ErrorBanner error={regenerate.error ?? returnToItems.error ?? submit.error} />

      {!data.current ? (
        <section className="generation-state">
          <span className="generation-icon"><FileClock size={24} /></span>
          <div><strong>本地 Agent 正在生成 Report</strong><span>页面会在任务完成后自动更新。</span></div>
          <RefreshCw className="spin" size={18} />
        </section>
      ) : (
        <div className="report-layout">
          <aside className="report-versions">
            <div className="section-heading"><div><h2>版本</h2><p>{data.versions.length} 个不可变版本</p></div></div>
            {data.versions.map((version) => (
              <button key={version.id} className={viewing?.version === version.version ? "active" : ""} onClick={() => setSelectedVersion(version.version)}>
                <span><strong>v{version.version}</strong>{version.version === data.report.current_version && <Badge tone="info">current</Badge>}</span>
                <time>{new Date(version.created_at).toLocaleString("zh-CN")}</time>
              </button>
            ))}
            <div className="report-provenance">
              <span>Snapshot checksum</span>
              <code>{viewing.source_checksum}</code>
              <span>Generator</span>
              <code>{viewing.generator_version}</code>
            </div>
          </aside>
          <article className="report-document">
            {!isCurrent && <div className="version-notice"><FileClock size={17} />正在查看历史版本 v{viewing.version}</div>}
            {isLocked && <div className="locked-notice"><CheckCircle2 size={18} />本期 Report 已锁定，事实与表达版本均不可再修改。</div>}
            <ReactMarkdown>{viewing.markdown}</ReactMarkdown>
            {(viewing.payload?.qualityWarnings ?? []).length > 0 && <section className="quality-warnings"><h3>生成质量提示</h3><ul>{viewing.payload.qualityWarnings.map((warning: string) => <li key={warning}>{warning}</li>)}</ul></section>}
          </article>
        </div>
      )}

      {preferencesOpen && <PreferencesModal value={preferences} onChange={setPreferences} onClose={() => setPreferencesOpen(false)} onRegenerate={() => regenerate.mutate()} loading={regenerate.isPending} />}
      {submitOpen && <Modal title="提交本期 Report" onClose={() => setSubmitOpen(false)} footer={<><Button variant="ghost" onClick={() => setSubmitOpen(false)}>取消</Button><Button icon={<Send size={16} />} loading={submit.isPending} onClick={() => submit.mutate()}>确认提交</Button></>}><div className="confirm-copy"><CheckCircle2 size={24} /><p>提交后当前版本将锁定。后续 Team 聚合只会读取这份已提交快照。</p></div></Modal>}
    </div>
  );
}

function PreferencesModal({ value, onChange, onClose, onRegenerate, loading }: { value: Preferences; onChange: (value: Preferences) => void; onClose: () => void; onRegenerate: () => void; loading: boolean }) {
  const update = <K extends keyof Preferences>(key: K, next: Preferences[K]) => onChange({ ...value, [key]: next });
  return <Modal title="调整 Report 表达" onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>取消</Button><Button icon={<RotateCcw size={16} />} loading={loading} onClick={onRegenerate}>生成新版本</Button></>}>
    <div className="form-row">
      <Field label="篇幅"><select value={value.length} onChange={(event) => update("length", event.target.value as Preferences["length"])}><option value="short">精简</option><option value="standard">标准</option><option value="detailed">详细</option></select></Field>
      <Field label="语言"><select value={value.language} onChange={(event) => update("language", event.target.value as Preferences["language"])}><option value="zh-CN">中文</option><option value="en-US">English</option></select></Field>
    </div>
    <Field label="技术细节"><div className="segmented-control">{(["low", "medium", "high"] as const).map((option) => <button type="button" className={value.technicalDetail === option ? "active" : ""} key={option} onClick={() => update("technicalDetail", option)}>{{ low: "低", medium: "中", high: "高" }[option]}</button>)}</div></Field>
    <Field label="本版侧重点" hint="仅影响表达，不会修改 Work Item Snapshot"><textarea rows={5} maxLength={500} value={value.emphasis} onChange={(event) => update("emphasis", event.target.value)} /></Field>
  </Modal>;
}
