import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArchiveX, Check, CheckCheck, ChevronRight, GitMerge, GitPullRequestCreate, Pencil, Plus, RefreshCw, RotateCcw, Save, Star } from "lucide-react";
import { useLocation, useRoute } from "wouter";
import { api } from "./api.js";
import { Badge, Button, EmptyState, ErrorBanner, Field, Modal } from "./components.js";

type ReviewData = { review: any; items: any[]; changes: any[]; coverage: any; snapshot: any; projects: any[] };
type Preview = { changeId: string; operation: string; before: any; after: any; expiresAt: string; baseVersion: number };

const statusLabels: Record<string, string> = {
  discussion: "讨论",
  planned: "计划",
  in_progress: "进行中",
  awaiting_validation: "待验证",
  completed: "已完成",
  blocked: "阻塞",
  cancelled: "取消"
};

export function ReviewPage() {
  const [, params] = useRoute("/partner/review/:reviewId");
  const reviewId = params?.reviewId ?? "";
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["review", reviewId], queryFn: () => api<ReviewData>(`/v1/reviews/${reviewId}`) });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<Preview | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [factOpen, setFactOpen] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);

  useEffect(() => {
    if (!selectedId && query.data?.items[0]) setSelectedId(query.data.items[0].id);
  }, [query.data, selectedId]);

  const previewMutation = useMutation({
    mutationFn: (input: { operation: string; workItemIds: string[]; value?: unknown }) => api<Preview>(`/v1/reviews/${reviewId}/changes/preview`, {
      method: "POST",
      body: JSON.stringify({ ...input, baseVersion: query.data!.review.version, source: "web" })
    }),
    onSuccess: setPreview
  });
  const applyMutation = useMutation({
    mutationFn: (changeId: string) => api(`/v1/reviews/${reviewId}/changes/apply`, { method: "POST", body: JSON.stringify({ changeId }) }),
    onSuccess: async () => {
      setPreview(null);
      setChecked(new Set());
      await queryClient.invalidateQueries({ queryKey: ["review", reviewId] });
      await queryClient.invalidateQueries({ queryKey: ["partner-dashboard"] });
    }
  });
  const completeMutation = useMutation({
    mutationFn: () => api<{ reportId: string }>(`/v1/reviews/${reviewId}/complete`, { method: "POST", body: JSON.stringify({ baseVersion: query.data!.review.version }) }),
    onSuccess: (result) => navigate(`/partner/report/${result.reportId}`)
  });

  if (query.isLoading) return <div className="page-loading"><RefreshCw className="spin" />加载审核事项</div>;
  if (query.isError) return <div className="page"><ErrorBanner error={query.error} /></div>;
  const data = query.data!;
  const selected = data.items.find((item) => item.id === selectedId) ?? data.items[0];
  const pending = data.items.filter((item) => item.review_status === "pending").length;
  const isEditable = data.review.state === "IN_PROGRESS";
  const canComplete = isEditable && data.items.length > 0 && pending === 0;

  const toggle = (id: string) => setChecked((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <div className="page review-page">
      <header className="page-header review-header"><div><span className="eyebrow">FIRST REVIEW</span><h1>Work Item 审核</h1><p>{data.items.length} 项 · {pending} 项待确认 · v{data.review.version}</p></div><div className="header-actions">{isEditable && checked.size >= 2 && <Button variant="secondary" icon={<GitMerge size={16} />} onClick={() => previewMutation.mutate({ operation: "merge", workItemIds: [...checked], value: { title: data.items.find((item) => checked.has(item.id))?.title ?? "合并事项" } })}>合并 {checked.size} 项</Button>}{isEditable && <Button disabled={!canComplete} loading={completeMutation.isPending} icon={<CheckCheck size={16} />} onClick={() => completeMutation.mutate()}>完成事项审核</Button>}</div></header>
      <ErrorBanner error={previewMutation.error ?? applyMutation.error ?? completeMutation.error} />
      <div className="review-layout">
        <aside className="item-list">
          {data.items.map((item) => <button key={item.id} className={`item-list-row ${item.id === selected?.id ? "active" : ""}`} onClick={() => setSelectedId(item.id)}>
            <input type="checkbox" checked={checked.has(item.id)} disabled={!isEditable} onChange={() => toggle(item.id)} onClick={(event) => event.stopPropagation()} aria-label={`选择 ${item.title}`} />
            <div><strong>{item.title}</strong><span>{statusLabels[item.status] ?? item.status} · {item.project_name ?? "独立工作"}</span></div>
            <Badge tone={item.review_status === "approved" ? "success" : item.review_status === "excluded" ? "neutral" : "warning"}>{item.review_status}</Badge>
            <ChevronRight size={16} />
          </button>)}
        </aside>
        <section className="item-detail">
          {!selected ? <EmptyState title="暂无 Work Item" /> : <>
            <div className="detail-title"><div><div className="title-badges"><Badge tone="info">{statusLabels[selected.status]}</Badge>{selected.payload.emphasis && <Badge tone="warning">重点</Badge>}</div><h2>{selected.title}</h2><p>{selected.payload.summary}</p></div>{isEditable && <Button variant="ghost" icon={<Pencil size={16} />} onClick={() => setEditOpen(true)}>编辑</Button>}</div>
            <div className="detail-grid"><DetailList title="成果" items={selected.payload.outcomes} /><DetailList title="阻塞" items={selected.payload.blockers} /><DetailList title="下一步" items={selected.payload.nextSteps} /><DetailList title="来源 Fact" items={selected.fact_ids} mono /></div>
            {isEditable && <div className="detail-actions">
              <Button icon={<Check size={16} />} onClick={() => previewMutation.mutate({ operation: "approve", workItemIds: [selected.id] })}>确认</Button>
              <Button variant="secondary" icon={<Star size={16} />} onClick={() => previewMutation.mutate({ operation: "set_emphasis", workItemIds: [selected.id], value: !selected.payload.emphasis })}>{selected.payload.emphasis ? "取消重点" : "设为重点"}</Button>
              {selected.review_status === "excluded" ? <Button variant="secondary" icon={<RotateCcw size={16} />} onClick={() => previewMutation.mutate({ operation: "restore", workItemIds: [selected.id] })}>恢复</Button> : <Button variant="danger" icon={<ArchiveX size={16} />} onClick={() => previewMutation.mutate({ operation: "exclude", workItemIds: [selected.id] })}>排除</Button>}
              <Button variant="secondary" icon={<Plus size={16} />} onClick={() => setFactOpen(true)}>补充事实</Button>
              <Button variant="secondary" icon={<GitPullRequestCreate size={16} />} disabled={selected.fact_ids.length < 2} onClick={() => setSplitOpen(true)}>拆分</Button>
            </div>}
          </>}
        </section>
      </div>
      {preview && <PreviewModal preview={preview} onClose={() => setPreview(null)} onApply={() => applyMutation.mutate(preview.changeId)} loading={applyMutation.isPending} />}
      {selected && editOpen && <EditItemModal item={selected} projects={data.projects} onClose={() => setEditOpen(false)} onPreview={(operation, value) => { setEditOpen(false); previewMutation.mutate({ operation, workItemIds: [selected.id], value }); }} />}
      {selected && factOpen && <AddFactModal onClose={() => setFactOpen(false)} onSave={(value) => { setFactOpen(false); previewMutation.mutate({ operation: "add_fact", workItemIds: [selected.id], value }); }} />}
      {selected && splitOpen && <SplitModal item={selected} onClose={() => setSplitOpen(false)} onSave={(value) => { setSplitOpen(false); previewMutation.mutate({ operation: "split", workItemIds: [selected.id], value }); }} />}
    </div>
  );
}

function DetailList({ title, items = [], mono }: { title: string; items?: string[]; mono?: boolean }) {
  return <div className="detail-list"><h3>{title}</h3>{items.length === 0 ? <span className="muted">无</span> : <ul className={mono ? "mono" : ""}>{items.map((item) => <li key={item}>{item}</li>)}</ul>}</div>;
}

function PreviewModal({ preview, onClose, onApply, loading }: { preview: Preview; onClose: () => void; onApply: () => void; loading: boolean }) {
  return <Modal title="Change Preview" onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>取消</Button><Button loading={loading} onClick={onApply}>应用变更</Button></>}><div className="preview-summary"><Badge tone="info">{preview.operation}</Badge><span>基于 Review v{preview.baseVersion}</span></div><div className="diff-grid"><div><h3>Before</h3><pre>{JSON.stringify(preview.before, null, 2)}</pre></div><div><h3>After</h3><pre>{JSON.stringify(preview.after, null, 2)}</pre></div></div></Modal>;
}

function EditItemModal({ item, projects, onClose, onPreview }: { item: any; projects: any[]; onClose: () => void; onPreview: (operation: string, value: unknown) => void }) {
  const [title, setTitle] = useState(item.title);
  const [summary, setSummary] = useState(item.payload.summary ?? "");
  const [status, setStatus] = useState(item.status);
  const [projectId, setProjectId] = useState(item.project_id ?? "");
  const textChanged = title !== item.title || summary !== (item.payload.summary ?? "");
  const statusChanged = status !== item.status;
  const projectChanged = projectId !== (item.project_id ?? "");
  const operation = textChanged ? "update_fact" : statusChanged ? "update_status" : "assign_project";
  const value = textChanged ? { title, summary } : statusChanged ? status : (projectId || null);
  return <Modal title="编辑 Work Item" onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>取消</Button><Button disabled={!textChanged && !statusChanged && !projectChanged} icon={<Save size={16} />} onClick={() => onPreview(operation, value)}>预览修改</Button></>}>
    <Field label="标题"><input value={title} onChange={(event) => setTitle(event.target.value)} /></Field>
    <Field label="摘要"><textarea rows={5} value={summary} onChange={(event) => setSummary(event.target.value)} /></Field>
    <div className="form-row"><Field label="状态"><select value={status} onChange={(event) => setStatus(event.target.value)}>{Object.entries(statusLabels).map(([option, label]) => <option value={option} key={option}>{label}</option>)}</select></Field><Field label="项目"><select value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">独立工作</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></Field></div>
  </Modal>;
}

function AddFactModal({ onClose, onSave }: { onClose: () => void; onSave: (value: unknown) => void }) {
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [status, setStatus] = useState("in_progress");
  return <Modal title="补充 Partner Fact" onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>取消</Button><Button onClick={() => onSave({ title, detail, status })}>预览补充</Button></>}><Field label="事实标题"><input value={title} onChange={(event) => setTitle(event.target.value)} /></Field><Field label="事实内容"><textarea rows={5} value={detail} onChange={(event) => setDetail(event.target.value)} /></Field><Field label="状态"><select value={status} onChange={(event) => setStatus(event.target.value)}>{Object.entries(statusLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></Field></Modal>;
}

function SplitModal({ item, onClose, onSave }: { item: any; onClose: () => void; onSave: (value: unknown) => void }) {
  const halfway = Math.ceil(item.fact_ids.length / 2);
  const [leftTitle, setLeftTitle] = useState(`${item.title} A`);
  const [rightTitle, setRightTitle] = useState(`${item.title} B`);
  const [left, setLeft] = useState<Set<string>>(new Set(item.fact_ids.slice(0, halfway)));
  const groups = [{ title: leftTitle, factIds: [...left] }, { title: rightTitle, factIds: item.fact_ids.filter((id: string) => !left.has(id)) }];
  return <Modal title="拆分 Work Item" onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>取消</Button><Button disabled={groups.some((group) => group.factIds.length === 0)} onClick={() => onSave({ groups })}>预览拆分</Button></>}><div className="split-grid"><div><Field label="第一项标题"><input value={leftTitle} onChange={(event) => setLeftTitle(event.target.value)} /></Field><div className="fact-picker">{item.fact_ids.map((id: string) => <label key={id}><input type="checkbox" checked={left.has(id)} onChange={() => setLeft((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; })} /><span>{id}</span></label>)}</div></div><div><Field label="第二项标题"><input value={rightTitle} onChange={(event) => setRightTitle(event.target.value)} /></Field><div className="fact-picker">{groups[1]!.factIds.map((id: string) => <span key={id}>{id}</span>)}</div></div></div></Modal>;
}
