import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  KeyRound,
  Link2,
  LoaderCircle,
  ShieldCheck,
} from "lucide-react";
import { useLocation } from "wouter";
import { api } from "./api.js";
import { Button, ErrorBanner, Field, SuccessBanner } from "./components.js";

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const googleLoginEnabled =
    import.meta.env.VITE_GOOGLE_LOGIN_ENABLED !== "false";
  const localLoginEnabled =
    import.meta.env.VITE_LOCAL_LOGIN_ENABLED !== "false";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const requestedNext = new URLSearchParams(window.location.search).get("next");
  const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const next =
    requestedNext?.startsWith("/") && !requestedNext.startsWith("//")
      ? requestedNext
      : currentPath === "/" || currentPath.startsWith("/login")
        ? "/admin"
        : currentPath;
  const login = useMutation({
    mutationFn: () =>
      api("/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      }),
    onSuccess: () => {
      window.history.replaceState(null, "", next);
      onSuccess();
    },
  });
  return (
    <div className="auth-page auth-page-login">
      <section className="auth-panel">
        <div className="auth-brand">
          <div className="brand-mark">PR</div>
          <span>Partner Report Agent</span>
        </div>
        <div className="auth-copy">
          <h1>登录工作台</h1>
          <p>Session 贡献、工作卡片与报告状态集中在这里。</p>
        </div>
        {localLoginEnabled ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              login.mutate();
            }}
          >
            <ErrorBanner error={login.error} />
            <Field label="邮箱">
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                required
              />
            </Field>
            <Field label="密码">
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                required
              />
            </Field>
            <Button
              type="submit"
              loading={login.isPending}
              icon={<ArrowRight size={17} />}
            >
              登录
            </Button>
          </form>
        ) : null}
        {googleLoginEnabled ? (
          <>
            {localLoginEnabled ? (
              <div className="auth-divider">
                <span>或</span>
              </div>
            ) : null}
            <GoogleLoginButton next={next} />
          </>
        ) : null}
        <div className="auth-security">
          <ShieldCheck size={16} />
          <span>
            {googleLoginEnabled && localLoginEnabled
              ? "Google 或本地账号"
              : googleLoginEnabled
                ? "Google 账号"
                : "本地账号"}{" "}
            · HttpOnly Session
          </span>
        </div>
      </section>
    </div>
  );
}

type GoogleLoginConfig = {
  clientId: string;
  loginUri: string;
  state: string;
  nonce: string;
};

type GoogleIdentityApi = {
  accounts: {
    id: {
      initialize: (options: {
        client_id: string;
        login_uri: string;
        ux_mode: "redirect";
        nonce: string;
        auto_select: boolean;
      }) => void;
      renderButton: (
        parent: HTMLElement,
        options: {
          type: "standard";
          theme: "outline";
          size: "large";
          text: "signin_with";
          shape: "rectangular";
          logo_alignment: "left";
          width: number;
          locale: string;
          state: string;
        },
      ) => void;
    };
  };
};

declare global {
  interface Window {
    google?: GoogleIdentityApi;
  }
}

let googleScriptPromise: Promise<void> | null = null;

function loadGoogleIdentityScript() {
  if (window.google) return Promise.resolve();
  if (googleScriptPromise) return googleScriptPromise;
  googleScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client?hl=zh_CN";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("无法加载 Google 登录组件。"));
    document.head.append(script);
  });
  return googleScriptPromise;
}

function GoogleLoginButton({ next }: { next: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [renderError, setRenderError] = useState<Error | null>(null);
  const config = useQuery({
    queryKey: ["google-login-config", next],
    queryFn: () =>
      api<GoogleLoginConfig>(`/auth/google?next=${encodeURIComponent(next)}`),
    retry: false,
    staleTime: 0,
  });

  useEffect(() => {
    if (!config.data || !containerRef.current) return;
    let cancelled = false;
    loadGoogleIdentityScript()
      .then(() => {
        if (cancelled || !window.google || !containerRef.current) return;
        window.google.accounts.id.initialize({
          client_id: config.data.clientId,
          login_uri: config.data.loginUri,
          ux_mode: "redirect",
          nonce: config.data.nonce,
          auto_select: false,
        });
        containerRef.current.replaceChildren();
        window.google.accounts.id.renderButton(containerRef.current, {
          type: "standard",
          theme: "outline",
          size: "large",
          text: "signin_with",
          shape: "rectangular",
          logo_alignment: "left",
          width: Math.min(496, containerRef.current.clientWidth),
          locale: "zh_CN",
          state: config.data.state,
        });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setRenderError(
            error instanceof Error
              ? error
              : new Error("无法加载 Google 登录组件。"),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [config.data]);

  const error = config.error ?? renderError;
  if (error) return <ErrorBanner error={error} />;
  return (
    <div className="google-login-container" ref={containerRef}>
      <LoaderCircle className="spin" size={18} />
    </div>
  );
}

export function AcceptInvite() {
  const [, navigate] = useLocation();
  const params = new URLSearchParams(window.location.search);
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const token = params.get("token") ?? "";
  const accept = useMutation({
    mutationFn: () =>
      api("/v1/auth/invitations/accept", {
        method: "POST",
        body: JSON.stringify({ token, displayName, password }),
      }),
    onSuccess: () => navigate("/partner"),
  });
  return (
    <div className="auth-page auth-page-single">
      <section className="auth-panel">
        <div className="auth-brand">
          <div className="brand-mark">PR</div>
          <span>Partner Report Agent</span>
        </div>
        <div className="auth-copy">
          <h1>接受邀请</h1>
          <p>创建本地账号并加入 Team。</p>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            accept.mutate();
          }}
        >
          <ErrorBanner error={accept.error} />
          <Field label="显示名称">
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              required
            />
          </Field>
          <Field label="密码" hint="至少 12 个字符">
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              minLength={12}
              required
            />
          </Field>
          <Button
            type="submit"
            loading={accept.isPending}
            icon={<KeyRound size={17} />}
          >
            创建账号
          </Button>
        </form>
      </section>
    </div>
  );
}

export function ConnectPlugin() {
  const params = new URLSearchParams(window.location.search);
  const [code, setCode] = useState(params.get("code") ?? "");
  const approve = useMutation({
    mutationFn: () =>
      api(
        `/v1/plugin-bindings/device-authorizations/${encodeURIComponent(code.trim().toUpperCase())}/approve`,
        { method: "POST" },
      ),
  });
  return (
    <div className="page page-narrow">
      <header className="page-header">
        <div>
          <span className="eyebrow">PLUGIN BINDING</span>
          <h1>连接 Codex Plugin</h1>
        </div>
      </header>
      <section className="tool-panel connect-panel">
        <div className="panel-icon">
          <Link2 size={24} />
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            approve.mutate();
          }}
        >
          <ErrorBanner error={approve.error} />
          {approve.isSuccess && (
            <SuccessBanner>设备已确认，Codex 正在领取令牌。</SuccessBanner>
          )}
          <Field label="设备码">
            <input
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              placeholder="ABCD-EFGH"
              maxLength={9}
              required
            />
          </Field>
          <Button
            type="submit"
            loading={approve.isPending}
            icon={<ShieldCheck size={17} />}
          >
            确认此设备
          </Button>
        </form>
      </section>
    </div>
  );
}
