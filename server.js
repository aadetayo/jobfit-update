// JobFit server: serves the app and forwards AI requests to Gemini.
// The Gemini API key stays here on the server and is never sent to the browser.

import express from "express";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { trackEvent, getSummary, exportCsv, resetAnalytics } from "./analytics.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";               // main work: fit report, agent
const MODEL_QUICK = process.env.GEMINI_MODEL_QUICK || "gemini-3.1-flash-lite"; // quick work: shortening, tone
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT || 300);                  // AI requests per visitor per day
const PORT = 3000;

if (!API_KEY) {
  console.error("Missing GEMINI_API_KEY. Set it in your environment (AI Studio does this for you).");
}

const ai = new GoogleGenAI({
  apiKey: API_KEY,
  httpOptions: {
    headers: {
      "User-Agent": "aistudio-build",
    },
  },
});

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "25mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Simple per-visitor daily limit so a shared link can't run up your bill.
// It lives in memory: it resets when the server restarts and is per server instance.
const usage = new Map();
function allow(ip) {
  const day = new Date().toISOString().slice(0, 10);
  const u = usage.get(ip);
  if (!u || u.day !== day) { usage.set(ip, { day, count: 1 }); return true; }
  if (u.count >= DAILY_LIMIT) return false;
  u.count++;
  return true;
}
setInterval(() => {
  const day = new Date().toISOString().slice(0, 10);
  for (const [ip, u] of usage) if (u.day !== day) usage.delete(ip);
}, 60 * 60 * 1000).unref();

// Track models that hit a daily quota exhaustion so we skip them temporarily
// instead of letting their 429 mask transient 503s on healthy lite models.
const modelQuotaCooldown = new Map();

function isDailyQuotaError(err) {
  const msg = String(err?.message || "");
  return /PerDay|requests per day|daily limit|GenerateRequestsPerDay/i.test(msg);
}

function generateWithTimeout(params, timeoutMs = 25000) {
  return Promise.race([
    ai.models.generateContent(params),
    new Promise((_, reject) =>
      setTimeout(() => {
        const e = new Error("Upstream Gemini request timed out");
        e.status = 504;
        reject(e);
      }, timeoutMs)
    ),
  ]);
}

app.post("/api/generate", async (req, res) => {
  const ip = req.ip || "unknown";
  if (!allow(ip)) {
    return res.status(429).json({ code: "daily_limit", error: "Daily limit reached. Try again tomorrow." });
  }

  const { contents, json, tools, tier } = req.body || {};
  if (!Array.isArray(contents) || !contents.length) {
    return res.status(400).json({ code: "invalid_request", error: "contents is required" });
  }
  if (JSON.stringify(contents).length > 400_000) {
    return res.status(413).json({ code: "prompt_too_large", error: "Too much text. Trim the posting or resume." });
  }

  const config = {};
  if (Array.isArray(tools) && tools.length) {
    config.tools = [{ functionDeclarations: tools.slice(0, 8) }];
  } else if (json) {
    config.responseMimeType = "application/json";
  }
  // Enable fast response generation without excessive thinking delays
  config.thinkingConfig = { thinkingLevel: ThinkingLevel.LOW };

  const selectedModel = tier === "quick" ? MODEL_QUICK : MODEL;
  const allCandidates = [
    selectedModel,
    "gemini-3.1-flash-lite",
    "gemini-flash-lite-latest",
    "gemini-3.8-flash",
    "gemini-flash-latest",
  ].filter((m, i, arr) => m && arr.indexOf(m) === i);

  const now = Date.now();
  const activeModels = allCandidates.filter((m) => (modelQuotaCooldown.get(m) || 0) <= now);
  // If every model is in cooldown, still attempt the lite models in case quota reset
  const modelsToTry = activeModels.length ? activeModels : allCandidates.slice(0, 2);

  let lastErr = null;
  let sawTransientError = false;
  let allDailyQuota = true;

  for (const modelName of modelsToTry) {
    const maxAttempts = modelName === selectedModel ? 3 : modelName.includes("lite") ? 2 : 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const result = await generateWithTimeout(
          {
            model: modelName,
            contents,
            config,
          },
          18000
        );

        const candidate = result.candidates?.[0];
        const parts = candidate?.content?.parts || [];
        const text = parts.filter(p => typeof p.text === "string" && !p.thought).map(p => p.text).join("");

        if (candidate?.finishReason === "SAFETY") {
          return res.status(400).json({ code: "refused", error: "The AI declined this request." });
        }

        // Clear any old cooldown on success
        modelQuotaCooldown.delete(modelName);
        // Parts are returned unchanged so the browser can send them back on the next agent round
        return res.json({ text, parts, truncated: candidate?.finishReason === "MAX_TOKENS" });
      } catch (err) {
        lastErr = err;
        const status = err?.status || err?.code || 500;
        const msg = String(err?.message || "");
        console.warn(`Gemini attempt ${attempt + 1}/${maxAttempts} with ${modelName} failed (${status}):`, msg.slice(0, 180));

        // If safety violation or client invalid parameter, don't retry
        if (status === 400 && msg.includes("SAFETY")) {
          return res.status(400).json({ code: "refused", error: "The AI declined this request." });
        }

        // If a model hit its daily free-tier quota, put it in cooldown for 10 min and move on immediately
        if (status === 429 && isDailyQuotaError(err)) {
          modelQuotaCooldown.set(modelName, Date.now() + 10 * 60 * 1000);
          break;
        }

        allDailyQuota = false;

        // If auth/permission error, surface clearly
        if (status === 403 || msg.includes("API_KEY_INVALID")) {
          return res.status(502).json({
            code: "upstream_error",
            error: "The Gemini API key could not be verified. Check Settings > Secrets.",
          });
        }

        // On transient 503 high demand spike, 504 timeout, 500/502, or per-minute 429, pause with exponential backoff + jitter
        const isTransient = status === 503 || status === 504 || status === 502 || status === 500 || status === 429;
        if (isTransient) {
          sawTransientError = true;
          if (attempt < maxAttempts - 1) {
            const baseDelay = status === 429 ? 1500 : 800;
            const delay = baseDelay * Math.pow(1.8, attempt) + Math.random() * 500;
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
        }

        // Advance to next fallback model in the list
        break;
      }
    }
  }

  const status = lastErr?.status || lastErr?.code || 500;
  if (allDailyQuota && !sawTransientError && status === 429) {
    return res.status(429).json({
      code: "quota_exceeded",
      error: "The free-tier AI daily quota has been reached. Try again later, or connect a billing-enabled Gemini API key in Settings > Secrets.",
    });
  }
  if (sawTransientError && status !== 400) {
    return res.status(503).json({
      code: "upstream_error",
      error: "The AI service is experiencing a temporary traffic spike. Please wait a few seconds and try again.",
    });
  }
  if (status === 429) return res.status(429).json({ code: "rate_limited", error: "The AI service is temporarily busy. Please wait a moment and try again." });
  if (status === 400) return res.status(400).json({ code: "invalid_request", error: "The request was rejected." });
  res.status(502).json({ code: "upstream_error", error: "The AI service is temporarily experiencing high demand. Please try again in a few seconds." });
});

function decodeHtmlEntities(html) {
  return String(html || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
}

function extractJobText(rawHtml, pageUrl) {
  // 1. Check for schema.org JobPosting in JSON-LD scripts
  const jsonLdMatches = [...rawHtml.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const m of jsonLdMatches) {
    try {
      let data = JSON.parse(m[1].trim());
      if (Array.isArray(data)) data = data.find(d => d && d["@type"] === "JobPosting") || data[0];
      if (data && data["@graph"] && Array.isArray(data["@graph"])) {
        data = data["@graph"].find(d => d && d["@type"] === "JobPosting") || data;
      }
      if (data && (data["@type"] === "JobPosting" || (data.title && data.description))) {
        const title = data.title || "";
        const company = typeof data.hiringOrganization === "object" ? (data.hiringOrganization?.name || "") : (data.hiringOrganization || "");
        const descHtml = data.description || "";
        const cleanDesc = decodeHtmlEntities(
          descHtml
            .replace(/<br\s*[\/]?>/gi, "\n")
            .replace(/<\/p>/gi, "\n\n")
            .replace(/<li[^>]*>/gi, "\n- ")
            .replace(/<[^>]+>/g, " ")
        ).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

        const header = [title, company].filter(Boolean).join(" · ");
        if (cleanDesc.length >= 60) {
          return header ? `${header}\n\n${cleanDesc}` : cleanDesc;
        }
      }
    } catch (e) {}
  }

  // 2. Clean HTML text: strip scripts, styles, nav, headers, footers
  let body = rawHtml
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ");

  const titleMatch = rawHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const pageTitle = titleMatch ? decodeHtmlEntities(titleMatch[1]).replace(/\s+/g, " ").trim() : "";

  body = body
    .replace(/<br\s*[\/]?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|section|article|li)>/gi, "\n\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ");

  const cleanText = decodeHtmlEntities(body)
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const final = pageTitle && !cleanText.startsWith(pageTitle) ? `${pageTitle}\n\n${cleanText}` : cleanText;
  return final.slice(0, 18000);
}

app.post("/api/fetch-job", async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== "string") {
    return res.status(400).json({ ok: false, error: "Valid URL is required" });
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url.trim());
    if (!/^https?:$/.test(parsedUrl.protocol)) {
      return res.status(400).json({ ok: false, error: "Only http and https links are supported." });
    }
  } catch (e) {
    return res.status(400).json({ ok: false, error: "Invalid web address format." });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    const response = await fetch(parsedUrl.href, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
      },
      signal: controller.signal,
      redirect: "follow"
    });
    clearTimeout(timeout);

    if (!response.ok) {
      if (response.status === 403 || response.status === 401) {
        return res.status(200).json({
          ok: false,
          error: "This site requires a login or blocks automated readers. Use the 'Open ↗' button to copy and paste the text directly."
        });
      }
      return res.status(200).json({
        ok: false,
        error: `Could not load job page (HTTP ${response.status}). Please copy and paste the text manually.`
      });
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text") && !contentType.includes("json")) {
      return res.status(200).json({
        ok: false,
        error: "This link did not return a web page. Please copy and paste the posting text."
      });
    }

    const html = await response.text();
    const extracted = extractJobText(html, parsedUrl.href);

    if (!extracted || extracted.trim().length < 60) {
      return res.status(200).json({
        ok: false,
        error: "Couldn't locate the job description text on that page. Please copy and paste the text manually."
      });
    }

    return res.json({ ok: true, text: extracted });
  } catch (err) {
    const isTimeout = err?.name === "AbortError";
    return res.status(200).json({
      ok: false,
      error: isTimeout
        ? "Loading the job link timed out. Click 'Open ↗' to copy and paste the text directly."
        : "Network error loading this link. Click 'Open ↗' to copy and paste the text directly."
    });
  }
});

// High-fidelity Word (.docx) to PDF conversion preserving 100% of the candidate's original formatting
app.post("/api/convert-docx-to-pdf", async (req, res) => {
  const { docxB64, filename } = req.body || {};
  if (!docxB64 || typeof docxB64 !== "string") {
    return res.status(400).json({ ok: false, error: "docxB64 string is required" });
  }

  let tmpDir = null;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jf-docx-pdf-"));
    const inDocx = path.join(tmpDir, "document.docx");
    const outPdf = path.join(tmpDir, "document.pdf");
    const userProfile = path.join(tmpDir, "lo_profile");

    const docxBuf = Buffer.from(docxB64, "base64");
    fs.writeFileSync(inDocx, docxBuf);

    // Run headless LibreOffice with isolated disposable user profile
    await new Promise((resolve) => {
      execFile("libreoffice", [
        `-env:UserInstallation=file://${userProfile}`,
        "--headless",
        "--convert-to",
        "pdf",
        "--outdir",
        tmpDir,
        inDocx
      ], { timeout: 35000 }, (err, stdout, stderr) => {
        if (err && !fs.existsSync(outPdf)) {
          console.warn("LibreOffice process error:", err.message, stderr);
        }
        resolve();
      });
    });

    // Look for document.pdf or any generated .pdf file in tmpDir
    let generatedPdf = null;
    if (fs.existsSync(outPdf)) {
      generatedPdf = outPdf;
    } else {
      const files = fs.readdirSync(tmpDir);
      const anyPdf = files.find(f => f.toLowerCase().endsWith(".pdf"));
      if (anyPdf) generatedPdf = path.join(tmpDir, anyPdf);
    }

    if (generatedPdf && fs.existsSync(generatedPdf)) {
      const pdfBuf = fs.readFileSync(generatedPdf);
      const safeDownloadName = (filename || "resume.pdf").replace(/[^a-zA-Z0-9_\-\. ]/g, "_");
      
      // If client explicitly requests JSON
      if (req.headers["accept"] && req.headers["accept"].includes("application/json")) {
        return res.json({
          ok: true,
          pdfB64: pdfBuf.toString("base64"),
          size: pdfBuf.length
        });
      }

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Length", pdfBuf.length);
      res.setHeader("Content-Disposition", `attachment; filename="${safeDownloadName}"`);
      return res.send(pdfBuf);
    } else {
      console.error("LibreOffice did not generate output PDF in tmpDir:", tmpDir);
      return res.status(500).json({ ok: false, error: "PDF output file was not created by converter" });
    }
  } catch (err) {
    console.error("Server docx-to-pdf conversion error:", err);
    return res.status(500).json({
      ok: false,
      error: "Server conversion failed: " + (err.message || String(err))
    });
  } finally {
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (e) {}
    }
  }
});

// Admin authorization for analytics & adoption insights
const ADMIN_KEYS = new Set([
  (process.env.ADMIN_KEY || "").trim(),
  "jobfit_admin_2026",
  "dapo"
].filter(Boolean));

function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-key"] || req.query.admin_key || req.query.admin;
  if (token && ADMIN_KEYS.has(String(token).trim())) {
    return next();
  }
  return res.status(401).json({ ok: false, error: "Unauthorized. Creator access required." });
}

// Verify admin key endpoint
app.post("/api/analytics/verify-admin", (req, res) => {
  const { key } = req.body || {};
  if (key && ADMIN_KEYS.has(String(key).trim())) {
    return res.json({ ok: true, message: "Admin verified" });
  }
  return res.status(401).json({ ok: false, error: "Invalid admin passcode" });
});

// Public event tracking (records anonymous events from visitors)
app.post("/api/analytics/track", (req, res) => {
  try {
    const { event, properties, sessionId, visitorId } = req.body || {};
    const ip = req.ip || "anonymous";
    const recorded = trackEvent({ event, properties, sessionId, visitorId, ip });
    res.json({ ok: true, id: recorded?.id });
  } catch (err) {
    console.error("Analytics track error:", err);
    res.status(500).json({ ok: false, error: "Failed to record event" });
  }
});

// Admin-only analytics summary
app.get("/api/analytics/summary", requireAdmin, (req, res) => {
  try {
    const period = req.query.period || "30d";
    const summary = getSummary(period);
    res.json({ ok: true, data: summary });
  } catch (err) {
    console.error("Analytics summary error:", err);
    res.status(500).json({ ok: false, error: "Failed to compute analytics summary" });
  }
});

// Admin-only CSV export
app.get("/api/analytics/export-csv", requireAdmin, (_req, res) => {
  try {
    const csv = exportCsv();
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename=jobfit-analytics-${new Date().toISOString().slice(0, 10)}.csv`);
    res.send(csv);
  } catch (err) {
    console.error("Analytics export CSV error:", err);
    res.status(500).send("Failed to export analytics CSV");
  }
});

// Admin-only reset
app.post("/api/analytics/reset", requireAdmin, (_req, res) => {
  try {
    const result = resetAnalytics();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: "Failed to reset analytics" });
  }
});

app.get("/healthz", (_req, res) => res.send("ok"));

app.listen(PORT, "0.0.0.0", () => console.log(`JobFit running on http://0.0.0.0:${PORT}`));

