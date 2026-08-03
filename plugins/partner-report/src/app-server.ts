import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export class CodexAppServer {
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private stderr = "";

  async connect() {
    this.process = spawn("codex", ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
    const lines = createInterface({ input: this.process.stdout });
    lines.on("line", (line) => {
      let message: any;
      try { message = JSON.parse(line); } catch { return; }
      if (typeof message.id !== "number") return;
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      clearTimeout(waiting.timer);
      this.pending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error.message ?? "Codex app-server request failed"));
      else waiting.resolve(message.result);
    });
    this.process.stderr.on("data", (chunk: Buffer) => { this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-4000); });
    this.process.on("exit", (code) => {
      for (const waiting of this.pending.values()) {
        clearTimeout(waiting.timer);
        waiting.reject(new Error(`Codex app-server exited (${code ?? "unknown"}): ${this.stderr}`));
      }
      this.pending.clear();
    });
    await this.request("initialize", { clientInfo: { name: "partner_report", title: "Partner Report", version: "0.1.0" } });
    this.notify("initialized", {});
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = 30_000) {
    if (!this.process) throw new Error("Codex app-server 尚未连接。");
    const id = this.nextId++;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.process!.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  notify(method: string, params: Record<string, unknown>) {
    if (!this.process) throw new Error("Codex app-server 尚未连接。");
    this.process.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async listThreads() {
    const threads: any[] = [];
    let cursor: string | null = null;
    do {
      const result = await this.request("thread/list", {
        ...(cursor ? { cursor } : {}),
        limit: 100,
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKinds: ["cli", "vscode", "appServer"]
      });
      threads.push(...(result.data ?? []));
      cursor = result.nextCursor ?? null;
    } while (cursor && threads.length < 2_000);
    return threads;
  }

  async readThread(threadId: string) {
    const result = await this.request("thread/read", { threadId, includeTurns: true }, 60_000);
    return result.thread;
  }

  close() {
    if (!this.process) return;
    this.process.stdin.end();
    this.process.kill("SIGTERM");
    this.process = null;
  }
}
