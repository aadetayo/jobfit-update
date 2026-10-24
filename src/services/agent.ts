import { Bullet, FitResult } from "../types";
import { sample, ToolDeclaration } from "./gemini";
import {
  bulletLines,
  extractNums,
  hasTerm,
  MAX_LINES,
  normTerm,
  resumeBulletList
} from "./parser";

export function buildPrompt(jd: string, resume: string, withBullets = true): string {
  return `You are an MBA career coach helping a candidate tailor their resume to one job.

RULES
- Use only facts present in the resume. Never invent employers, tools, metrics, titles, or outcomes.
- If a rewrite adds framing or a claim not clearly supported by the original bullet, set needs_confirmation to true and explain what to confirm in confirm_note.
${
  withBullets
    ? `- Pick the 3 to 5 resume bullets most relevant to this job and rewrite each: start with a strong verb, keep the original numbers, one sentence, use the job's vocabulary where truthful. HARD LIMIT: each rewritten bullet must fit on two lines of a resume, which means 180 characters or fewer including spaces. Cut filler words before cutting results or numbers.`
    : "- bullets: return an empty array []. A separate step writes them."
}
- List 5 to 8 distinct requirements from the job. importance is "required" for must-haves and "preferred" for anything the posting calls a plus, preferred, bonus, or nice to have. status is "strong" (clear evidence), "partial" (related evidence), or "missing". evidence is a short paraphrase of the resume, or "" if missing. For partial and missing items, tip is one sentence on how to address the gap in an application or interview; for strong items tip is "".
- Do not calculate a score. JobFit calculates it from the requirements.
- key_terms: 10 to 15 skills, tools, and phrases a recruiter would scan for, in the posting's exact wording (short, 1 to 3 words each). supported is true when the resume's experience truthfully backs the term, even if the resume words it differently; false when nothing on the resume backs it.
- outreach: a warm, specific note under 110 words to someone on the hiring team asking for a 15-minute chat. Use [Name] and [Your name] placeholders. Mention one concrete result from the resume.
- role: the job title and company, written as "Title · Company".
- The job description may be a whole copied web page with menus, ads, other job listings, or cookie notices. Use only the one main job posting and ignore everything else. If it holds no job posting at all, return fit_score 0, role "No job posting found", and verdict "Paste the text of the job posting and try again.", with empty arrays.

Reply with only JSON in exactly this shape:
{"role":"","verdict":"two sentences max","requirements":[{"requirement":"","importance":"required","status":"strong","evidence":"","tip":""}],"bullets":[{"original":"","rewritten":"","why":"","needs_confirmation":false,"confirm_note":""}],"key_terms":[{"term":"","supported":true}],"outreach":{"to":"","message":""}}

JOB DESCRIPTION
${jd.slice(0, 20000)}

RESUME
${resume.slice(0, 20000)}`;
}

export function checkDraft(
  d: { bullet_id?: string; rewritten?: string; needs_confirmation?: boolean },
  ctx: { byId: Map<string, { id: string; text: string }>; terms: string[]; resumeLow: string }
) {
  const id = String(d?.bullet_id || "");
  const src = ctx.byId.get(id);
  const text = String(d?.rewritten || "").trim();
  const issues: string[] = [];
  const warnings: string[] = [];

  if (!src) issues.push(`bullet_id "${id}" doesn't exist. Use an id from RESUME BULLETS.`);
  if (!text) issues.push("rewritten is empty.");
  const lines = bulletLines(text);
  if (lines > MAX_LINES) {
    issues.push(`${lines} lines (${text.length} characters). Must be ${MAX_LINES} lines or fewer; aim for 170 characters.`);
  }

  if (src) {
    const a = extractNums(src.text);
    const b = extractNums(text);
    const invented = [...b].filter((n) => !a.has(n));
    if (invented.length) {
      issues.push(`contains numbers not in the original bullet: ${invented.join(", ")}. Remove them.`);
    }
    const dropped = [...a].filter((n) => !b.has(n));
    if (dropped.length) {
      warnings.push(`drops numbers from the original: ${dropped.join(", ")}. Keep them if they fit.`);
    }
    const low = text.toLowerCase();
    const srcLow = src.text.toLowerCase();
    const unsupported = ctx.terms.filter(
      (t) => t && low.includes(t.toLowerCase()) && !srcLow.includes(t.toLowerCase()) && !ctx.resumeLow.includes(t.toLowerCase())
    );
    if (unsupported.length && !d.needs_confirmation) {
      issues.push(
        `uses ${unsupported.map((t) => `"${t}"`).join(", ")}, which the resume never mentions. Remove it, or set needs_confirmation true with a confirm_note.`
      );
    }
  }

  return { bullet_id: id, lines, passes: !issues.length, issues, warnings };
}

export function agentPrompt(
  r: FitResult,
  jd: string,
  list: Array<{ id: string; text: string }>,
  resume: string
): string {
  const reqs = (r.requirements || []).map((q) => `- ${q.requirement} (${q.status})`).join("\n");
  return `You are a resume-tailoring agent working inside a web page. Your goal: rewrite the 3 to 5 resume bullets most relevant to this job so that every one
(1) fits on ${MAX_LINES} lines of a resume,
(2) uses only facts from its own original bullet, and
(3) uses the job's language where it's truthful.

How to work:
1. Choose bullets by id from RESUME BULLETS. If you're unsure whether the resume supports a term, call search_resume.
2. Draft all rewrites, then call check_bullets once with every draft.
3. Revise each draft that fails, and check the revisions together. Keep going until all pass.
4. Call submit_bullets with the final set. If it returns an error, fix what it names and submit again.
5. After a successful submit, reply with one sentence summarizing what you changed, then stop.

Rules: start each bullet with a strong verb. Use the posting's own words for skills the candidate has, so the resume reads in the employer's language. Keep the original numbers when they fit. Never add numbers, tools, employers, or outcomes that aren't in the original bullet. If a rewrite adds framing beyond the original, set needs_confirmation to true and say what to confirm in confirm_note. "why" is one short sentence naming the job requirement the bullet targets.

JOB
${r.role || ""}

REQUIREMENTS (status vs. this resume)
${reqs}

POSTING TERMS YOU SHOULD WORK IN WHERE TRUTHFUL (the candidate's experience supports them, but the resume doesn't use these words)
${(r.key_terms || [])
  .filter((k) => k.supported && !hasTerm(normTerm(resume), k.term))
  .map((k) => k.term)
  .join(", ") || "none"}

POSTING TERMS THE RESUME DOESN'T SUPPORT (never use these without needs_confirmation)
${(r.key_terms ? r.key_terms.filter((k) => !k.supported).map((k) => k.term) : r.keywords_missing || []).join(", ") || "none"}

JOB POSTING (excerpt)
${jd.slice(0, 6000)}

RESUME BULLETS
${list.map((b) => `${b.id}: ${b.text}`).join("\n")}`;
}

export async function runBulletAgent(
  r: FitResult,
  jd: string,
  resume: string,
  onLog: (text: string, ok: boolean | null) => void,
  signal?: AbortSignal
): Promise<boolean> {
  const list = resumeBulletList(resume);
  const ctx = {
    byId: new Map(list.map((b) => [b.id, b])),
    terms: (r.key_terms ? r.key_terms.filter((k) => !k.supported).map((k) => k.term) : r.keywords_missing || []).map(String),
    resumeLow: resume.toLowerCase()
  };

  r._agent = { status: "running", steps: [], summary: "" };
  if (list.length < 2) {
    r._agent.status = "failed";
    onLog("Couldn't find bullet points in your resume.", false);
    return false;
  }

  onLog(`Read your resume: ${list.length} bullets to choose from.`, true);
  let final: any[] | null = null;
  const lastChecked = new Map<string, { draft: any; check: any }>();

  const tools: ToolDeclaration[] = [
    {
      name: "search_resume",
      description:
        "Search the full resume text (all sections, including skills and education) for a word or phrase. Returns up to 5 matching lines, or an empty list. Use it to confirm whether the resume supports a term before using it.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: "Word or short phrase to look for" } },
        required: ["query"]
      },
      execute(input) {
        const q = String(input.query || "").trim().toLowerCase();
        if (!q) throw new Error("query is empty");
        const hits = resume
          .split("\n")
          .map((s) => s.trim())
          .filter((s) => s && s.toLowerCase().includes(q))
          .slice(0, 5);
        onLog(
          `Searched your resume for "${input.query}": ${hits.length ? hits.length + " match" + (hits.length > 1 ? "es" : "") : "not found"}.`,
          hits.length ? true : null
        );
        return { query: input.query, matches: hits };
      }
    },
    {
      name: "check_bullets",
      description:
        "Check draft rewrites against the rules. Returns, for each draft: line count, passes (true/false), issues that must be fixed, and warnings. Send every draft in one call.",
      inputSchema: {
        type: "object",
        properties: {
          drafts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                bullet_id: { type: "string" },
                rewritten: { type: "string" },
                needs_confirmation: { type: "boolean" }
              },
              required: ["bullet_id", "rewritten"]
            }
          }
        },
        required: ["drafts"]
      },
      execute(input) {
        const drafts = Array.isArray(input.drafts) ? input.drafts : [];
        if (!drafts.length) throw new Error("drafts is empty");
        const res = drafts.slice(0, 8).map((d: any) => {
          const c = checkDraft(d, ctx);
          lastChecked.set(c.bullet_id, { draft: d, check: c });
          return c;
        });
        const pass = res.filter((c: any) => c.passes).length;
        onLog(
          `Checked ${res.length} draft${res.length > 1 ? "s" : ""}: ${pass} passed${
            pass < res.length ? ", " + (res.length - pass) + " need revision" : ""
          }.`,
          pass === res.length
        );
        res
          .filter((c: any) => !c.passes)
          .forEach((c: any) => onLog(`${c.bullet_id}: ${c.issues[0]}`, false));
        return res;
      }
    },
    {
      name: "submit_bullets",
      description:
        "Submit the final 3 to 5 bullets. Every bullet is re-checked; if any fails, this returns an error naming what to fix. Call it only when check_bullets shows all drafts passing.",
      inputSchema: {
        type: "object",
        properties: {
          bullets: {
            type: "array",
            items: {
              type: "object",
              properties: {
                bullet_id: { type: "string" },
                rewritten: { type: "string" },
                why: { type: "string" },
                needs_confirmation: { type: "boolean" },
                confirm_note: { type: "string" }
              },
              required: ["bullet_id", "rewritten", "why"]
            }
          }
        },
        required: ["bullets"]
      },
      execute(input) {
        const bs = Array.isArray(input.bullets) ? input.bullets : [];
        if (bs.length < 3 || bs.length > 5) {
          onLog(`Submission rejected: ${bs.length} bullets (needs 3 to 5).`, false);
          throw new Error(`Submit 3 to 5 bullets; you sent ${bs.length}.`);
        }
        const ids = bs.map((b: any) => String(b.bullet_id));
        if (new Set(ids).size !== ids.length) {
          onLog("Submission rejected: the same bullet appears twice.", false);
          throw new Error("Each bullet_id may appear only once.");
        }
        const fails = bs.map((b: any) => checkDraft(b, ctx)).filter((c: any) => !c.passes);
        if (fails.length) {
          onLog(`Submission rejected: ${fails.length} bullet${fails.length > 1 ? "s" : ""} still failing.`, false);
          throw new Error(fails.map((c: any) => `${c.bullet_id}: ${c.issues.join(" ")}`).join("\n"));
        }
        final = bs;
        onLog(`Submitted ${bs.length} bullets. All passed the checks.`, true);
        return "Accepted. Reply with one sentence summarizing what you changed, then stop.";
      }
    }
  ];

  try {
    onLog("Drafting rewrites…", null);
    const { text } = await sample(agentPrompt(r, jd, list, resume), {
      tools,
      signal,
      modelTier: "default"
    });
    r._agent.summary = String(text || "").trim().split(/\n\s*\n/).pop()?.slice(0, 400) || "";
  } catch (e: any) {
    if (e && e.code === "cancelled") {
      r._agent.status = "stopped";
      onLog("Stopped.", null);
      if (!final) throw e;
    } else if (!final) {
      onLog("The agent ran into a problem before it finished.", false);
    }
  }

  if (!final) {
    const passing = [...lastChecked.values()].filter((v) => v.check.passes).map((v) => v.draft);
    if (passing.length) {
      final = passing.slice(0, 5);
      onLog(`Used the ${final.length} draft${final.length > 1 ? "s" : ""} that passed before the agent stopped.`, null);
    }
  }

  if (!final) {
    r._agent.status = "failed";
    return false;
  }

  r.bullets = final.map((b) => ({
    original: ctx.byId.get(String(b.bullet_id))?.text || "",
    rewritten: String(b.rewritten).trim(),
    why: String(b.why || ""),
    needs_confirmation: !!b.needs_confirmation,
    confirm_note: String(b.confirm_note || "")
  }));
  delete r._accept;
  delete r._edited;
  if (r._agent.status === "running") r._agent.status = "done";
  return true;
}

export async function shortenBullets(
  list: Array<{ rewritten: string }>,
  signal?: AbortSignal
): Promise<void> {
  if (!list.length) return;
  const prompt = `Shorten each resume bullet so it fits on two lines: 170 characters or fewer including spaces. Keep the strong opening verb, every number, and the main result. Remove filler, not facts. Add nothing new.

Reply with only a JSON array of strings, one per bullet, in the same order.

${JSON.stringify(list.map((b) => b.rewritten))}`;

  const out = await sample.json(prompt, { modelTier: "quick", cache: false, signal });
  if (!Array.isArray(out)) return;
  list.forEach((b, i) => {
    const s = typeof out[i] === "string" ? out[i].trim() : "";
    if (s && s.length < String(b.rewritten).length) b.rewritten = s;
  });
}

export async function fallbackBullets(
  r: FitResult,
  jd: string,
  resume: string,
  signal?: AbortSignal
): Promise<void> {
  const out = await sample.json(
    `Rewrite the 3 to 5 resume bullets most relevant to this job. Start with a strong verb, keep the original numbers, use only facts from the original bullet, and keep each rewrite to 170 characters or fewer. If a rewrite adds framing beyond the original, set needs_confirmation true and explain in confirm_note.

Reply with only a JSON array: [{"original":"exact original bullet","rewritten":"","why":"one short sentence","needs_confirmation":false,"confirm_note":""}]

Use the posting's own words for skills the candidate has. Terms to work in where truthful: ${(r.key_terms || [])
      .filter((k) => k.supported)
      .map((k) => k.term)
      .join(", ") || "none"}.
Never use these unsupported terms: ${(r.key_terms || [])
      .filter((k) => !k.supported)
      .map((k) => k.term)
      .join(", ") || "none"}.

JOB: ${r.role || ""}
REQUIREMENTS: ${(r.requirements || []).map((q) => q.requirement).join("; ")}

RESUME
${resume.slice(0, 20000)}`,
    { signal, modelTier: "default" }
  );

  if (!Array.isArray(out)) throw { code: "invalid_json" };
  r.bullets = out.filter((b) => b && b.rewritten).slice(0, 5);
  const over = r.bullets.filter((b) => bulletLines(b.rewritten) > MAX_LINES);
  if (over.length) {
    await shortenBullets(over, signal);
  }
}
