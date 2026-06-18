/**
 * 真 VLM 槽：OpenAI 兼容多模态 `/chat/completions`（P3.D，照 CloudEmbedAdapter 同形）。
 * baseURL 约定含 /v1，实际打 `${baseURL}/chat/completions`，帧以 data URL（base64）随消息送出。
 * 槽契约 caption(frames)→文本：把一或多帧理解为一段中文情报描述。
 * 边界：零外发授权由调用方（摄入 process() 的 media-ingest）出站前完成，不写进适配器内部。
 */
import type { VlmAdapter, VlmOptions } from "./slots.js";

const TIMEOUT_MS = 120_000; // 32B VLM 较慢，给足
const MAX_TOKENS = 512;
const CAPTION_PROMPT =
  "你是情报图像分析助手。用中文客观描述画面中与情报相关的要素：人物、装备/载具（型号或显著特征）、场景/地点线索、可见文字与标识、关键动作或事件。只描述能直接看到的，不臆测、不编造。";

/** 按魔数嗅探图像 MIME（抽帧/上传图常见格式）；未知按 jpeg 处理。 */
function sniffMime(b: Buffer): string {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (b.length >= 6 && (b.toString("ascii", 0, 6) === "GIF87a" || b.toString("ascii", 0, 6) === "GIF89a")) return "image/gif";
  return "image/jpeg";
}

function dataUrl(frame: Buffer): string {
  return `data:${sniffMime(frame)};base64,${frame.toString("base64")}`;
}

/** OpenAI 兼容多模态响应 → 配文文本。纯函数，便于单测。缺 choices / content 非串即抛（fail-closed）。 */
export function extractCaption(json: unknown): string {
  const choices = (json as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) throw new Error("VLM 响应缺少 choices");
  const content = (choices[0] as { message?: { content?: unknown } }).message?.content;
  if (typeof content === "string") return content.trim();
  // 部分 OpenAI 兼容端把 content 返回为分段数组 [{type:"text",text}]：拼接文本段（便于部署换本地端点）。
  if (Array.isArray(content)) {
    const text = content
      .map((p) => (typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
      .join("")
      .trim();
    if (text) return text;
  }
  throw new Error("VLM 响应 message.content 非字符串");
}

export class CloudVlmAdapter implements VlmAdapter {
  readonly engine: string;
  private readonly baseURL: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(baseURL: string, opts: { model: string; apiKey?: string }) {
    if (!opts.model) throw new Error("CloudVlmAdapter 需要 model（设 MINI_AGENT_VLM_MODEL）");
    this.baseURL = baseURL.replace(/\/$/, "");
    this.apiKey = opts.apiKey ?? "";
    this.model = opts.model;
    this.engine = `vlm:${opts.model}`;
  }

  async caption(frames: Buffer[], opts?: VlmOptions): Promise<string> {
    if (frames.length === 0) return "";
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const content = [
      { type: "text", text: CAPTION_PROMPT },
      ...frames.map((f) => ({ type: "image_url", image_url: { url: dataUrl(f) } })),
    ];

    const res = await fetch(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: this.model, messages: [{ role: "user", content }], max_tokens: MAX_TOKENS, temperature: 0 }),
      signal: opts?.signal ?? AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`VLM HTTP ${res.status}`);
    return extractCaption(await res.json());
  }
}
