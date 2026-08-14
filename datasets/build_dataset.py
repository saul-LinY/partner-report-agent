#!/usr/bin/env python3
"""把本会话轨迹重构为 JSONL 蒸馏数据集示例，并做完整性校验。

用法：
    python3 datasets/build_dataset.py

输出：
    datasets/examples/session-trajectory.jsonl
"""
import json
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent / "examples"
OUT_PATH = OUT_DIR / "session-trajectory.jsonl"


def tc(call_id: str, name: str, arguments: dict) -> dict:
    """构造一条工具调用。"""
    return {"id": call_id, "type": "function", "function": {"name": name, "arguments": arguments}}


def tool(call_id: str, name: str, content: str) -> dict:
    """构造一条工具返回。"""
    return {"role": "tool", "tool_call_id": call_id, "name": name, "content": content}


def assistant(tool_calls=None, content=None, reasoning=None) -> dict:
    """构造一条助手消息：可同时含 tool_calls 与最终 content。"""
    msg = {"role": "assistant", "content": content}
    if tool_calls:
        msg["tool_calls"] = tool_calls
    if reasoning:
        msg["reasoning"] = reasoning
    return msg


SYSTEM = {
    "role": "developer",
    "content": (
        "你是一名编程智能体，负责在工作区 /Users/saul/PROJECT/partner-report-agent 内分析代码仓库。"
        "可用工具：bash（执行命令）、glob（按路径模式找文件）、grep（搜索内容）、read（读取文本文件）。"
        "用简体中文回答；结论必须有文件或代码依据，不要臆测。"
    ),
}

# ---------------------------------------------------------------------------
# 示例 1：项目分析（多轮工具调用的完整轨迹）
# ---------------------------------------------------------------------------
EXAMPLE_1 = {
    "id": "traj-2026-08-14-partner-report-analysis-001",
    "source": "deepseek-harness-web-gui-session",
    "created_at": "2026-08-14T00:00:00Z",
    "task": {
        "instruction": "帮我分析一下这个项目",
        "domain": "code-analysis",
        "language": "zh",
    },
    "system": SYSTEM,
    "messages": [
        {"role": "user", "content": "帮我分析一下这个项目"},
        assistant(
            reasoning="先看目录结构与关键文件，形成整体认识。",
            tool_calls=[
                tc("c1", "bash", {"command": "pwd && ls -la", "description": "列出当前目录"}),
                tc("c2", "glob", {"pattern": "*"}),
            ],
        ),
        tool("c1", "bash", "total 592\ndrwxr-xr-x  saul  staff  .git\n-rw-r--r--  README.md\n-rw-r--r--  package.json\napps/  packages/  plugins/  docs/\n[TRUNCATED]"),
        tool("c2", "glob", "README.md, package.json, apps/…, packages/…, plugins/…（100 of 20109 paths）"),
        assistant(
            reasoning="读取入口文档与工程配置，定位 monorepo 结构。",
            tool_calls=[
                tc("c3", "read", {"file_path": "/Users/saul/PROJECT/partner-report-agent/README.md"}),
                tc("c4", "read", {"file_path": "/Users/saul/PROJECT/partner-report-agent/package.json"}),
            ],
        ),
        tool("c3", "read", "# Partner Report Agent\n部署认证服务时参阅 docs/GOOGLE_AUTH.md……\n[TRUNCATED] 87 行"),
        tool("c4", "read", '{\n  "name": "partner-report-agent",\n  "workspaces": ["apps/*", "packages/*", "plugins/partner-report"],\n  "scripts": { "dev": "…", "test": "vitest run", "typecheck": "…" }\n}\n[TRUNCATED]'),
        assistant(
            reasoning="产品是「本地提取 + 中台聚合 + 双层审核」的周报系统；继续读核心契约与数据模型确认职责边界。",
            tool_calls=[
                tc("c5", "read", {"file_path": "/Users/saul/PROJECT/partner-report-agent/packages/contracts/src/index.ts"}),
                tc("c6", "read", {"file_path": "/Users/saul/PROJECT/partner-report-agent/packages/db/src/schema.ts"}),
            ],
        ),
        tool("c5", "read", "export const sessionContributionSchema = z.object({…});\n// 敏感信息检测 containsSensitiveValue(…)\n[TRUNCATED] 475 行"),
        tool("c6", "read", "tenants / teams / partners / plugin_binding_codes / session_facts / work_items / team_reports … 全部带 tenant_id\n[TRUNCATED] 1239 行"),
        assistant(
            reasoning="核对服务入口、后台 Worker 与插件清单，再跑一次 typecheck 验证工程健康度。",
            tool_calls=[
                tc("c7", "bash", {"command": "npm run typecheck 2>&1 | tail -40", "description": "运行 TypeScript 类型检查"}),
            ],
        ),
        tool("c7", "bash", "> partner-report-agent@0.1.0 typecheck\n所有 workspace 均通过（exit 0）"),
        assistant(
            content=(
                "## 项目概览\n\n"
                "**Partner Report Agent** 是一个面向团队工作汇报的 Human-in-the-loop 系统："
                "在成员本地的 Codex 对话里提取结构化中文工作事实（原始聊天不出本地），"
                "中台跨 Session 聚合成工作事项 → 个人周报 → 团队周报，并通过飞书完成授权与两轮审核。\n\n"
                "## 代码结构（npm workspaces monorepo）\n\n"
                "| 模块 | 职责 |\n| --- | --- |\n"
                "| apps/api | Fastify 5 REST 服务：认证/Admin/Plugin/Facts/Jobs/Review/Report/TeamReport + 飞书集成 |\n"
                "| apps/web | React 19 + Vite 7 的 Admin 工作台 |\n"
                "| apps/worker | 后台 Worker：周期冻结、中台模型生成任务 |\n"
                "| packages/contracts | zod 共享契约 + 敏感信息检测 + 报告语义断言 |\n"
                "| packages/db | Drizzle ORM，30+ 张表，18 个迁移，tenant_id 贯穿 |\n"
                "| plugins/partner-report | Codex 插件：本地采集、提取、上传 |\n\n"
                "## 端到端工作流\n\n"
                "1. Partner 绑定 → 2. 飞书身份确认 + 项目授权 → 3. 定时采集（每天 14:30）→ "
                "4. 周期冻结 + 工作事项聚合 → 5. 工作事项审核 → 6. 个人报告生成与审核 → 7. 团队报告归档。\n\n"
                "## 技术栈 / 数据模型 / 隐私\n\n"
                "Node 22 + TypeScript + Fastify 5 + React 19 + Drizzle + PostgreSQL 17 + Zod + argon2 + Google OIDC + 飞书 SDK。"
                "隐私上：原始对话、绝对路径、Session 原始标识不上传；项目授权前不读 Session；多租户隔离。\n\n"
                "## 健康度\n\n✅ 分层清晰、契约驱动、39 个测试、typecheck 通过；⚠️ 插件 CLI 单文件过大、文档与实现进度有偏差。"
            ),
        ),
    ],
    "labels": {
        "task_completed": True,
        "final_answer_verbatim": False,
        "tool_calls": 7,
        "has_retry": False,
        "has_denial": False,
    },
}

# ---------------------------------------------------------------------------
# 示例 2：安全审查（定向检索 + 结论）
# ---------------------------------------------------------------------------
EXAMPLE_2 = {
    "id": "traj-2026-08-14-partner-report-security-002",
    "source": "deepseek-harness-web-gui-session",
    "created_at": "2026-08-14T00:00:00Z",
    "task": {
        "instruction": "你觉得目前有哪些安全性问题",
        "domain": "security-review",
        "language": "zh",
    },
    "system": SYSTEM,
    "messages": [
        {"role": "user", "content": "你觉得目前有哪些安全性问题"},
        assistant(
            reasoning="按真实攻击面分级：账号接管、长期凭证、会话安全、多租户越权。先看认证与凭证处理。",
            tool_calls=[
                tc("s1", "grep", {"pattern": "bindingCode|code_value|accessToken|refreshToken|token_hash", "path": "apps/api/src", "include": "*.ts"}),
                tc("s2", "grep", {"pattern": "rateLimit|lockout|INVALID_CREDENTIALS", "path": "apps/api/src", "include": "*.ts"}),
            ],
        ),
        tool("s1", "grep", "routes/admin.ts:413 code_value\nroutes/plugin.ts:181 accessToken …\n[TRUNCATED] 87 matches"),
        tool("s2", "grep", "routes/auth.ts:114 INVALID_CREDENTIALS\n（未发现限流/锁定逻辑）"),
        assistant(
            reasoning="确认：绑定码明文入库、登录无暴力破解防护、公开设备授权接口无鉴权。再核对会话与种子默认值。",
            tool_calls=[
                tc("s3", "read", {"file_path": "/Users/saul/PROJECT/partner-report-agent/packages/db/src/seed.ts"}),
                tc("s4", "read", {"file_path": "/Users/saul/PROJECT/partner-report-agent/apps/api/src/auth-security.ts"}),
            ],
        ),
        tool("s3", "read", "const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? \"123456\";\n[TRUNCATED] 91 行"),
        tool("s4", "read", "SESSION_MAX_AGE_MS = 14 天；cookieSecure() 读取 X-Forwarded-Proto\n[TRUNCATED] 380 行"),
        assistant(
            content=(
                "## 高风险\n\n"
                "1. 默认管理员密码 123456，且生产不拦截（seed.ts）。\n"
                "2. 登录/绑定码认领/设备授权均无限流，可爆破或枚举。\n"
                "3. 公开设备授权接口无鉴权，可制造表膨胀（worker 只标记 expired 不清理）。\n"
                "4. 配置 Google SSO 后本地密码登录仍始终开放，可绕过域名/MFA 限制。\n\n"
                "## 中风险\n\n"
                "5. Binding Code 明文长期入库且 Admin 可查全文，DB 泄露即可接管未认领实例。\n"
                "6. 敏感信息检测规则窄，漏检邮箱/手机号/内网地址/工单号等。\n"
                "7. 多租户仅靠应用层 tenant_id，无 RLS；一处漏条件即跨租户。\n"
                "8. Web Session 固定 14 天，无空闲超时、无集中撤销。\n\n"
                "## 加固\n\n"
                "9. 日志脱敏缺 bindingCode/credential/token。\n"
                "10. cookieSecure 信任客户端 X-Forwarded-Proto。\n\n"
                "## 已做对的\n\n"
                "Token 全 hash 存储、Argon2id、Google 登录校验 state/nonce/aud、原始 Session ID 不上传、大部分查询带 tenant_id。\n\n"
                "优先处理：弱默认密码、关闭本地登录开关、公开接口限流、设备授权垃圾清理。"
            ),
        ),
    ],
    "labels": {
        "task_completed": True,
        "final_answer_verbatim": False,
        "tool_calls": 4,
        "has_retry": False,
        "has_denial": False,
    },
}

# ---------------------------------------------------------------------------
# 示例 3：工程修改建议（诊断 + 优先级排序）
# ---------------------------------------------------------------------------
EXAMPLE_3 = {
    "id": "traj-2026-08-14-partner-report-changes-003",
    "source": "deepseek-harness-web-gui-session",
    "created_at": "2026-08-14T00:00:00Z",
    "task": {
        "instruction": "你觉得目前有什么需要修改的地方",
        "domain": "code-review",
        "language": "zh",
    },
    "system": SYSTEM,
    "messages": [
        {"role": "user", "content": "你觉得目前有什么需要修改的地方"},
        assistant(
            reasoning="先定位认证、种子、模型网关与团队报告交付的现状，再下结论。",
            tool_calls=[
                tc("m1", "grep", {"pattern": "DELIVERED|MONITOR_REVIEW|pdf|PDF|render", "path": "apps", "include": "*.ts"}),
                tc("m2", "grep", {"pattern": "session_quiet_period_minutes|collection_grace_minutes", "path": ".", "include": "*.ts"}),
            ],
        ),
        tool("m1", "grep", "team_reports 终态 = LOCKED；无 DELIVERED/MONITOR_REVIEW/PDF 渲染\n[TRUNCATED] 79 matches"),
        tool("m2", "grep", "schema.ts:64-69 与 admin.ts:997（仅出现，采集流程不使用）"),
        assistant(
            reasoning="确认文档与实现漂移 + 死字段。整理为 P0/P1/P2 的可执行清单。",
            tool_calls=[
                tc("m3", "read", {"file_path": "/Users/saul/PROJECT/partner-report-agent/apps/worker/src/model.ts"}),
            ],
        ),
        tool("m3", "read", "MODEL_API_KEY 为空即抛错；但 .env.example 指向本地 Ollama（通常无 key）\n[TRUNCATED] 198 行"),
        assistant(
            content=(
                "## P0 安全\n\n"
                "1. 默认管理员密码 123456，且登录无暴力破解防护（seed.ts、auth.ts）。\n"
                "2. .env.example 泄漏个人/内网默认值（saul@laien.io、172.20.10.14）。\n\n"
                "## P1 一致性与健壮性\n\n"
                "3. 团队报告的 Monitor 交付 + PDF 在代码里不存在（终态是 LOCKED）。\n"
                "4. session_quiet_period_minutes / collection_grace_minutes 是与设计冲突的死字段。\n"
                "5. 模型网关与本地 Ollama 不兼容（无 key 直接抛错）。\n\n"
                "## P2 可维护性\n\n"
                "6. Worker 每 15s 只处理 1 个生成任务（约 4 job/min，单进程）。\n"
                "7. session_id 列名误导（实为匿名 sha256 key）。\n"
                "8. cookieSecure 信任任意 X-Forwarded-Proto。\n\n"
                "建议顺序：先做 #1/#2（半天内），再做 #3 的文档对齐。"
            ),
        ),
    ],
    "labels": {
        "task_completed": True,
        "final_answer_verbatim": False,
        "tool_calls": 3,
        "has_retry": False,
        "has_denial": False,
    },
}

EXAMPLES = [EXAMPLE_1, EXAMPLE_2, EXAMPLE_3]


def validate(messages: list[dict]) -> list[str]:
    """校验轨迹完整性：tool_call_id 可回指、角色合法、最终有回答。"""
    errors = []
    known_ids = set()
    has_final = False
    for m in messages:
        role = m.get("role")
        if role not in ("user", "assistant", "tool"):
            errors.append(f"非法角色: {role}")
        if role == "assistant":
            for c in m.get("tool_calls", []):
                known_ids.add(c["id"])
            if m.get("content"):
                has_final = True
        elif role == "tool":
            if m["tool_call_id"] not in known_ids:
                errors.append(f"悬空 tool_call_id: {m['tool_call_id']}")
    if not has_final:
        errors.append("缺少最终助手回答")
    return errors


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with OUT_PATH.open("w", encoding="utf-8") as f:
        for ex in EXAMPLES:
            errs = validate(ex["messages"])
            if errs:
                raise SystemExit(f"{ex['id']} 校验失败: {errs}")
            f.write(json.dumps(ex, ensure_ascii=False) + "\n")
    print(f"写出 {len(EXAMPLES)} 条轨迹 -> {OUT_PATH}")


if __name__ == "__main__":
    main()
