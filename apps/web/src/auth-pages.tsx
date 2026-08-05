import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ArrowRight, KeyRound, Link2, ShieldCheck } from "lucide-react";
import { useLocation } from "wouter";
import { api } from "./api.js";
import { Button, ErrorBanner, Field, SuccessBanner } from "./components.js";

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [email, setEmail] = useState("saul@laien.io");
  const [password, setPassword] = useState("123456");
  const login = useMutation({
    mutationFn: () =>
      api("/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      }),
    onSuccess,
  });
  return (
    <div className="auth-page">
      <section className="auth-panel">
        <div className="auth-brand">
          <div className="brand-mark">PR</div>
          <span>Partner Report Agent</span>
        </div>
        <div className="auth-copy">
          <h1>登录工作台</h1>
          <p>Session 贡献、工作卡片与报告状态集中在这里。</p>
        </div>
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
        <div className="auth-security">
          <ShieldCheck size={16} />
          <span>本地账号 · HttpOnly Session</span>
        </div>
      </section>
      <div className="auth-aside">
        <div>
          <span className="eyebrow">CURRENT CYCLE</span>
          <strong>事实先确认，表达后调整。</strong>
          <p>未经 Partner 审核的内容不会进入最终 Report。</p>
        </div>
      </div>
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
