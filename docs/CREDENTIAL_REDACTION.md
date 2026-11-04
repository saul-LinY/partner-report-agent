# 凭证脱敏

成员在对话里贴过密钥、令牌或口令时，这些值不应该进入中台。凭证只指「拿到就能访问系统」的值；邮箱、地址、本地路径、文件名保持原样，不属于这里。

## 两层

| 层 | 位置 | 作用 |
|---|---|---|
| App 上传前 | `apps/macos/Sources/Core/SecretScrubber.swift`，在 `CollectorPackage` 打包时处理 | 凭证不离开成员电脑 |
| 服务端入库前 | `redactSessionCredentials`，在 `POST /v1/collector/uploads/:id/parts` 里，校验分片完整性之后、写入 `collector_upload_parts` 之前 | 旧版 App 和 App 漏掉的内容也不落库 |

两层用同一套规则（`packages/contracts/src/privacy.ts` 的 `redactCredentials`），只改写标题、提问和回复三类文本，其余字段（编号、时间、模型名）原样保存，空白和换行也不变。分片校验值描述的是 App 发出的内容，服务端不会再用存储的内容重新计算它。

本机上传队列里，旧版 App 在升级前已经打好的包不会被重新处理，这部分靠服务端那一层兜底。

## 规则

隐藏为 `[已隐藏]`：

- `sk-…`、GitHub、Slack、AWS 风格的令牌，`Bearer …`，私钥块。
- `password=…`、`api_key: …` 这类赋值。
- 32 位以上的十六进制串，以及 40 位以上同时含大写、小写、数字的长串。
- 写在句子里的凭证：「密码、口令、密钥、令牌、凭证、token、secret」之后、同一个分句内（遇到逗号、句号、分号、换行停止，最多 40 个字符）出现的 6 位以上字母数字串，贴着斜杠的路径片段不算。

已知的取舍：40 位十六进制会被当作密钥，所以 git 提交哈希也会被隐藏；规则只覆盖上面这些写法，不能保证识别所有凭证。

## 两端一致

`packages/contracts/src/privacy-vectors.json` 是两端共用的测试向量，TypeScript（`privacy.test.ts`）和 Swift（`SecretScrubberTests`）都必须对每条给出完全相同的输出。规则里不用 `\b`，因为 JavaScript 把中文当作非单词字符、Swift 的正则把中文当作单词字符，边界一律用 ASCII 前后断言写出。改规则时先改向量，再改两端。

## 已存数据

`apps/api/src/redact-stored-sessions.ts` 把已经入库的会话也清一遍。默认只统计并打印脱敏后的上下文，不写库：

```
cd apps/api && node --import tsx src/redact-stored-sessions.ts          # 空跑
cd apps/api && node --import tsx src/redact-stored-sessions.ts --apply  # 写回
```

写回不可逆：原文只剩成员本机那一份。由工作卡、项目简介等派生出来的文本不在这个脚本范围内。
