import type { ReactNode } from "react";
import { AlertCircle, CheckCircle2, Info, LoaderCircle, X } from "lucide-react";

export function Button({
  children,
  icon,
  variant = "primary",
  loading,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: ReactNode;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  loading?: boolean;
}) {
  return (
    <button className={`button button-${variant}`} {...props} disabled={props.disabled || loading}>
      {loading ? <LoaderCircle size={16} className="spin" /> : icon}
      <span>{children}</span>
    </button>
  );
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: string | undefined }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function EmptyState({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <Info size={22} />
      <strong>{title}</strong>
      {action}
    </div>
  );
}

export function ErrorBanner({ error, onClose }: { error: unknown; onClose?: () => void }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="error-banner" role="alert">
      <AlertCircle size={18} />
      <span>{message}</span>
      {onClose && <button className="icon-button" onClick={onClose} title="关闭"><X size={16} /></button>}
    </div>
  );
}

export function SuccessBanner({ children }: { children: ReactNode }) {
  return <div className="success-banner"><CheckCircle2 size={18} /><span>{children}</span></div>;
}

export function Modal({ title, children, onClose, footer }: { title: string; children: ReactNode; onClose: () => void; footer?: ReactNode }) {
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <header><h2>{title}</h2><button className="icon-button" onClick={onClose} title="关闭"><X size={18} /></button></header>
        <div className="modal-body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </section>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
