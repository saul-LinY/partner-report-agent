import { useEffect, useRef, type ReactNode } from "react";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ListFilter,
  RefreshCw,
  Search,
  X,
  type LucideIcon,
} from "lucide-react";
import { Link, useLocation } from "wouter";
import { navigationGroupLabel } from "./navigation.js";
import "./admin-workspace.css";

export function AdminFilterBar({
  children,
  label = "筛选条件",
}: {
  children: ReactNode;
  label?: string;
}) {
  return (
    <section className="aw-filter-bar" aria-label={label}>
      <div className="aw-filter-heading">
        <ListFilter size={16} />
        <strong>{label}</strong>
      </div>
      <div className="aw-toolbar">{children}</div>
    </section>
  );
}

export function WorkspaceHeader({
  title,
  icon: Icon,
  context,
  children,
}: {
  title: string;
  icon: LucideIcon;
  context?: ReactNode;
  children?: ReactNode;
}) {
  const [location] = useLocation();
  return (
    <header className="aw-header">
      <div className="aw-header-copy">
        <span className="aw-breadcrumb">
          管理台 / {navigationGroupLabel(location) ?? "团队运营"}
        </span>
        <h1>
          <Icon size={24} />
          {title}
        </h1>
        {context && <div className="aw-context">{context}</div>}
      </div>
      {children && <div className="aw-header-actions">{children}</div>}
    </header>
  );
}

export function AdminHeader({
  title,
  icon: Icon,
  context,
  refreshing,
  onRefresh,
  children,
}: {
  title: string;
  icon: LucideIcon;
  context?: ReactNode;
  refreshing?: boolean;
  onRefresh: () => void;
  children?: ReactNode;
}) {
  return (
    <WorkspaceHeader title={title} icon={Icon} context={context}>
      {children}
      <button
        className="icon-button"
        title={`刷新${title}`}
        disabled={refreshing}
        onClick={onRefresh}
      >
        <RefreshCw size={17} className={refreshing ? "spin" : ""} />
      </button>
    </WorkspaceHeader>
  );
}

export function AdminMetrics({
  items,
}: {
  items: Array<{
    label: string;
    value: ReactNode;
    tone?: string;
    href?: string;
  }>;
}) {
  return (
    <section className="aw-metrics" aria-label="数据汇总">
      {items.map((item) => {
        const content = (
          <>
            <span>{item.label}</span>
            <strong>{item.value}</strong>
          </>
        );
        return item.href ? (
          <Link
            key={item.label}
            href={item.href}
            className={`aw-metric aw-metric-link ${item.tone ?? ""}`}
          >
            {content}
            <ChevronRight size={16} />
          </Link>
        ) : (
          <div key={item.label} className={`aw-metric ${item.tone ?? ""}`}>
            {content}
          </div>
        );
      })}
    </section>
  );
}

export function AdminSearch({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="aw-search">
      <Search size={16} />
      <input
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {value && (
        <button
          className="icon-button"
          title={`清除${label}`}
          onClick={() => onChange("")}
        >
          <X size={14} />
        </button>
      )}
    </label>
  );
}

export function AdminTabs<T extends string>({
  label,
  value,
  onChange,
  items,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  items: Array<{ value: T; label: string; count?: number; icon?: LucideIcon }>;
}) {
  return (
    <div className="aw-tabs" role="tablist" aria-label={label}>
      {items.map((item, index) => (
        <button
          key={item.value}
          role="tab"
          id={`aw-tab-${item.value}`}
          aria-controls={`aw-panel-${item.value}`}
          aria-selected={value === item.value}
          tabIndex={value === item.value ? 0 : -1}
          onClick={() => onChange(item.value)}
          onKeyDown={(event) => {
            const next =
              event.key === "ArrowRight"
                ? (index + 1) % items.length
                : event.key === "ArrowLeft"
                  ? (index + items.length - 1) % items.length
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? items.length - 1
                      : null;
            if (next === null) return;
            event.preventDefault();
            const selected = items[next]!;
            onChange(selected.value);
            document.getElementById(`aw-tab-${selected.value}`)?.focus();
          }}
        >
          {item.icon && <item.icon size={16} />}
          {item.label}
          {item.count !== undefined && <span>{item.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function AdminPagination({
  page,
  pageCount,
  total,
  onChange,
  loading = false,
  label = "记录分页",
  children,
}: {
  page: number;
  pageCount: number;
  total: number;
  onChange: (page: number) => void;
  loading?: boolean;
  label?: string;
  children?: ReactNode;
}) {
  return (
    <nav className="aw-pagination" aria-label={label}>
      <span>{children ?? `共 ${total} 条记录`}</span>
      <div>
        <button
          className="icon-button"
          title="上一页"
          disabled={loading || page <= 1}
          onClick={() => onChange(page - 1)}
        >
          <ChevronLeft size={16} />
        </button>
        <span aria-live="polite">
          {page} / {pageCount}
        </span>
        <button
          className="icon-button"
          title="下一页"
          disabled={loading || page >= pageCount}
          onClick={() => onChange(page + 1)}
        >
          <ChevronRight size={16} />
        </button>
      </div>
    </nav>
  );
}

export function AdminWorkspace({
  list,
  children,
  open,
  onBack,
  selectionKey,
  label,
}: {
  list: ReactNode;
  children: ReactNode;
  open: boolean;
  onBack: () => void;
  selectionKey?: string | undefined;
  label: string;
}) {
  const detail = useRef<HTMLElement>(null);
  const records = useRef<HTMLDivElement>(null);
  useEffect(() => {
    detail.current?.scrollTo(0, 0);
  }, [selectionKey]);
  useEffect(() => {
    if (open) detail.current?.focus();
  }, [open]);
  return (
    <div className={`aw-workspace ${open ? "aw-detail-open" : ""}`}>
      <div className="aw-records" ref={records} tabIndex={-1}>
        {list}
      </div>
      <section
        className="aw-detail"
        aria-label={label}
        ref={detail}
        tabIndex={-1}
      >
        <button
          className="aw-text-button aw-back"
          onClick={() => {
            onBack();
            records.current?.focus();
          }}
        >
          <ArrowLeft size={15} />
          返回列表
        </button>
        {children}
      </section>
    </div>
  );
}

export function AdminTableScroll({
  children,
  resetKey,
}: {
  children: ReactNode;
  resetKey: string;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scroll.current?.scrollTo(0, 0);
  }, [resetKey]);
  return (
    <div className="aw-table-scroll" ref={scroll}>
      {children}
    </div>
  );
}
