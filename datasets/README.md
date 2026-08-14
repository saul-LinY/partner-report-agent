# Agent 轨迹蒸馏数据集

本目录展示如何把一个真实 Agent 会话的「轨迹」（trajectory）整理成可用于
模型蒸馏的数据集示例。

一条轨迹 = 一次完整任务的执行过程：

```text
用户指令 → 思考 → 工具调用 → 工具返回 → 思考 → … → 最终回答
```

对蒸馏而言，最有用、也最可复现的是**可观测的工具调用轨迹**
（interleaved tool transcript）：它不依赖私有思维链，只需记录
「助手发了哪个工具调用 → 系统返回了什么 → 助手最后输出了什么」。

## 文件结构

```text
datasets/
├── README.md             # 本说明：格式规范 + 转换方法 + 质量建议
├── build_dataset.py      # 生成脚本：内置本会话轨迹示例 + 输出校验
└── examples/
    └── session-trajectory.jsonl   # 生成的 JSONL 示例（每条一行 = 一条轨迹）
```

重新生成：

```bash
python3 datasets/build_dataset.py
```

## 格式规范（JSONL，每行一条轨迹）

```json
{
  "id": "traj-2026-08-14-partner-report-analysis-001",
  "source": "deepseek-harness-web-gui-session",
  "created_at": "2026-08-14T00:00:00Z",
  "task": {
    "instruction": "帮我分析一下这个项目",
    "domain": "code-analysis",
    "language": "zh"
  },
  "system": { "role": "developer", "content": "……" },
  "messages": [
    { "role": "user", "content": "帮我分析一下这个项目" },
    {
      "role": "assistant",
      "content": null,
      "reasoning": "先看目录结构与关键文件，形成概览",   // 可选，蒸馏推理链时填充
      "tool_calls": [
        {
          "id": "call_001",
          "type": "function",
          "function": {
            "name": "bash",
            "arguments": { "command": "pwd && ls -la", "description": "List current directory" }
          }
        }
      ]
    },
    { "role": "tool", "tool_call_id": "call_001", "name": "bash", "content": "……" },
    {
      "role": "assistant",
      "content": "项目是一个……",       // 最终回答 = 蒸馏的「目标输出」
      "tool_calls": []
    }
  ],
  "labels": {
    "task_completed": true,
    "final_answer_verbatim": false,
    "tool_calls": 8,
    "has_retry": false,
    "has_denial": false
  }
}
```

### 字段约定

| 字段 | 说明 |
| --- | --- |
| `messages[].role` | `user` / `assistant` / `tool` 三种，兼容 OpenAI 工具调用格式 |
| `assistant.reasoning` | 可选。蒸馏「带思维链」的推理模型（R1 风格）时填充真实 CoT；否则留空 |
| `assistant.tool_calls` | 该助手消息发出的工具调用；`content` 为 `null` 表示本轮只调用工具 |
| `tool.tool_call_id` | 必须能回指某条 `assistant.tool_calls[].id`，用于校验轨迹完整性 |
| `tool.content` | 工具返回。**生产数据必须逐字保留**；本示例因篇幅对超长输出做了摘要，并用 `labels.final_answer_verbatim` / 内容内 `[TRUNCATED]` 标注 |
| `labels` | 结果/质量标签，是蒸馏时做 reward/filter 的依据 |

### 关键标签（蒸馏质量信号）

- `task_completed`：任务是否完成；
- `has_retry` / `has_denial`：轨迹里是否出现重试、被沙箱/权限拒绝；
- `final_answer_verbatim`：最终回答是否逐字抓取。

蒸馏前建议先做「轨迹筛选」：优先保留 `task_completed=true` 且无大量重试的轨迹；
把「被拒绝/失败后如何恢复」的轨迹单独作为负样本或抗干扰样本，而不是混进主集。

## 如何转成常见训练格式

### 1. OpenAI Responses / tool-use 格式

JSONL 本身就是 OpenAI 的 messages 结构，`role: "tool"` 通用。直接可用于
支持 tool-call 的 SFT 流程（Axolotl、LLaMA-Factory 等均支持）。

### 2. 文本化（无工具头的聊天模板）

把 `tool_calls` 序列化为文本特殊 token，例如：

```python
def to_text(messages):
    out = []
    for m in messages:
        if m["role"] == "user":
            out.append(f"用户: {m['content']}")
        elif m["role"] == "assistant":
            if m.get("reasoning"):
                out.append(f"思考: {m['reasoning']}")
            for tc in m.get("tool_calls", []):
                out.append(f"工具调用: {tc['function']['name']} {json.dumps(tc['function']['arguments'], ensure_ascii=False)}")
            if m.get("content"):
                out.append(f"助手: {m['content']}")
        else:
            out.append(f"工具返回: {m['content']}")
    return "\n".join(out)
```

### 3. 仅「指令 → 最终回答」的 SFT（蒸馏回答风格）

丢弃中间工具调用，只保留 `task.instruction` 作为 prompt、最终 `assistant.content`
作为 completion。适合蒸馏「给定任务直接产出结构清晰的回答」的能力。

## 诚实声明（重要）

- 本示例是**单次会话的忠实重构**，不是可直接训练的完整语料；
- 超长工具返回做了摘要，`final_answer_verbatim=false` 表示最终回答经过整理、
  非逐字抓取——真实蒸馏流水线应从运行日志里**逐字**落盘；
- 真正可用的数据集需要：多任务、多领域、格式一致、带结果标签，并经过去重与质量过滤。
