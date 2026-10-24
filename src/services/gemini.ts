export interface ToolDeclaration {
  name: string;
  description: string;
  inputSchema?: Record<string, any>;
  execute: (args: any, context?: { signal?: AbortSignal }) => Promise<any> | any;
}

export interface SampleOptions {
  signal?: AbortSignal;
  onText?: (data: { text: string; delta: string }) => void;
  tools?: ToolDeclaration[];
  modelTier?: "default" | "quick";
  cache?: boolean;
  __json?: boolean;
}

export interface SampleResult {
  text: string;
  truncated: boolean;
  modelTierApplied: string;
}

export const ERR: Record<string, string> = {
  not_granted: "JobFit couldn't reach its AI. Reload the page and try again.",
  sampling_disabled: "JobFit's AI isn't available right now. Try again later.",
  rate_limited: "You've reached today's limit for JobFit. Try again tomorrow, or wait a few minutes if the AI is busy.",
  session_expired: "Your session expired. Reload JobFit and try again.",
  prompt_too_large: "That's too much text. Trim the posting or resume and try again.",
  invalid_json: "The report came back unreadable. Try again.",
  refused: "The AI declined this request. Check the text you pasted and try again.",
  empty_completion: "No report came back. Try again."
};

function toContents(input: string | Array<{ role: string; content: string }>) {
  if (typeof input === "string") {
    return [{ role: "user", parts: [{ text: input }] }];
  }
  return input.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: String(m.content) }]
  }));
}

const textOf = (parts: any[]) =>
  (parts || [])
    .filter((p) => p && typeof p.text === "string" && !p.thought)
    .map((p) => p.text)
    .join("");

const API = "/api/generate";
const MAX_ROUNDS = 10;

async function post(body: any, signal?: AbortSignal) {
  let res: Response;
  try {
    res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal
    });
  } catch (e: any) {
    if (e && e.name === "AbortError") throw { code: "cancelled", message: "cancelled" };
    throw { code: "upstream_error", message: "Network error" };
  }

  let j: any = {};
  try {
    j = await res.json();
  } catch {}

  if (!res.ok) {
    throw {
      code:
        j.code ||
        (res.status === 429
          ? "rate_limited"
          : res.status === 413
          ? "prompt_too_large"
          : "upstream_error"),
      message: j.error || ("HTTP " + res.status)
    };
  }
  return j;
}

export async function sample(
  input: string | Array<{ role: string; content: string }>,
  opts: SampleOptions = {}
): Promise<SampleResult> {
  const { signal, onText, tools, modelTier } = opts;
  if (signal && signal.aborted) throw { code: "cancelled", message: "cancelled" };

  const tier = modelTier === "quick" ? "quick" : "default";

  if (!Array.isArray(tools) || !tools.length) {
    const j = await post({ contents: toContents(input), json: !!opts.__json, tier }, signal);
    const text = String(j.text || "");
    if (!text.trim()) throw { code: "empty_completion", message: "The model returned no text." };
    if (typeof onText === "function") {
      try {
        onText({ text, delta: text });
      } catch {}
    }
    return { text, truncated: !!j.truncated, modelTierApplied: tier };
  }

  // Multi-round agent tool loop
  const decls = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.inputSchema || { type: "object", properties: {} }
  }));

  const contents: any[] = toContents(input);
  let all = "";

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const j = await post({ contents, tools: decls, tier, final: round === MAX_ROUNDS - 1 }, signal);
    const parts = Array.isArray(j.parts) ? j.parts : [];
    contents.push({ role: "model", parts }); // Send back unchanged with any thought signatures

    const t = textOf(parts);
    if (t) {
      all += (all ? "\n\n" : "") + t;
      if (typeof onText === "function") {
        try {
          onText({ text: all, delta: t });
        } catch {}
      }
    }

    const calls = parts.filter((p: any) => p && p.functionCall);
    if (!calls.length) break;

    const responses: any[] = [];
    for (const p of calls) {
      const fc = p.functionCall;
      const tool = tools.find((x) => x.name === fc.name);
      let out: any;
      try {
        if (!tool) throw new Error("Unknown tool " + fc.name);
        out = await tool.execute(fc.args || {}, { signal: signal || new AbortController().signal });
      } catch (err: any) {
        out = { error: "Error: " + String((err && err.message) || err) };
      }
      if (signal && signal.aborted) throw { code: "cancelled", message: "cancelled", text: all };
      const response = out && typeof out === "object" && !Array.isArray(out) ? out : { result: out };
      responses.push({ functionResponse: { name: fc.name, ...(fc.id ? { id: fc.id } : {}), response } });
    }
    contents.push({ role: "user", parts: responses });
  }

  if (!all.trim()) all = "Done.";
  return { text: all, truncated: false, modelTierApplied: tier };
}

sample.json = async function <T = any>(
  input: string | Array<{ role: string; content: string }>,
  opts: SampleOptions = {}
): Promise<T> {
  const { text } = await sample(input, { ...opts, __json: true });
  const tryParse = (s: string) => {
    try {
      return { ok: true, v: JSON.parse(s) };
    } catch {
      return { ok: false };
    }
  };

  let r = tryParse(text);
  if (r.ok) return r.v;

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    r = tryParse(fence[1]);
    if (r.ok) return r.v;
  }

  const a = text.search(/[\[{]/);
  const b = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (a >= 0 && b > a) {
    r = tryParse(text.slice(a, b + 1));
    if (r.ok) return r.v;
  }

  throw { code: "invalid_json", message: "Couldn't read the AI's reply.", text };
};

sample.limits = async () => ({ maxPromptBytes: 262144, tools: { maxCount: 8 } });
