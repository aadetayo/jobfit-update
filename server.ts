import express from "express";
import { GoogleGenAI } from "@google/genai";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_KEY = process.env.GEMINI_API_KEY;
// Defaults tuned for fit report, agent, and quick tasks
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const MODEL_QUICK = process.env.GEMINI_MODEL_QUICK || "gemini-2.5-flash-lite";
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT || 150);
const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";

if (!API_KEY) {
  console.warn("Missing GEMINI_API_KEY. Set it in your environment (AI Studio does this for you).");
}
const ai = new GoogleGenAI({ apiKey: API_KEY || "" });

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "1mb" }));

// Simple per-visitor daily limit
const usage = new Map<string, { day: string; count: number }>();
function allow(ip: string): boolean {
  const day = new Date().toISOString().slice(0, 10);
  const u = usage.get(ip);
  if (!u || u.day !== day) {
    usage.set(ip, { day, count: 1 });
    return true;
  }
  if (u.count >= DAILY_LIMIT) return false;
  u.count++;
  return true;
}

setInterval(() => {
  const day = new Date().toISOString().slice(0, 10);
  for (const [ip, u] of usage) {
    if (u.day !== day) usage.delete(ip);
  }
}, 60 * 60 * 1000).unref();

app.post("/api/generate", async (req, res) => {
  const ip = (req.ip || "unknown") as string;
  if (!allow(ip)) {
    return res.status(429).json({ code: "rate_limited", error: "Daily limit reached. Try again tomorrow." });
  }

  const { contents, json, tools, tier } = req.body || {};
  if (!Array.isArray(contents) || !contents.length) {
    return res.status(400).json({ code: "invalid_request", error: "contents is required" });
  }

  if (JSON.stringify(contents).length > 400_000) {
    return res.status(413).json({ code: "prompt_too_large", error: "Too much text. Trim the posting or resume." });
  }

  const config: Record<string, any> = {};
  if (Array.isArray(tools) && tools.length) {
    config.tools = [{ functionDeclarations: tools.slice(0, 8) }];
  } else if (json) {
    config.responseMimeType = "application/json";
  }

  try {
    const selectedModel = tier === "quick" ? MODEL_QUICK : MODEL;
    const result = await ai.models.generateContent({
      model: selectedModel,
      contents,
      config,
    });

    const candidate = result.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const text = parts
      .filter((p: any) => typeof p.text === "string" && !p.thought)
      .map((p: any) => p.text)
      .join("");

    if (candidate?.finishReason === "SAFETY") {
      return res.status(400).json({ code: "refused", error: "The AI declined this request." });
    }

    res.json({ text, parts, truncated: candidate?.finishReason === "MAX_TOKENS" });
  } catch (err: any) {
    const status = err?.status || err?.code || 500;
    console.error("Gemini error:", status, err?.message || err);
    if (status === 429) {
      return res.status(429).json({ code: "rate_limited", error: "The AI is busy. Try again in a minute." });
    }
    if (status === 400) {
      return res.status(400).json({ code: "invalid_request", error: "The request was rejected." });
    }
    res.status(502).json({ code: "upstream_error", error: "The AI service had a problem. Try again." });
  }
});

app.get("/healthz", (_req, res) => res.send("ok"));

async function startServer() {
  const isDev = process.env.NODE_ENV !== "production";
  if (isDev) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, HOST, () => {
    console.log(`JobFit running on http://${HOST}:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
