import React, { useState } from "react";
import { sample } from "../services/gemini";
import {
  bulletLines,
  computeFit,
  extractNums,
  hasTerm,
  isPreferred,
  MAX_LINES,
  normTerm,
  resumeBulletList,
  similarity,
  syncAccept
} from "../services/parser";
import { DetailResult, FitResult, Requirement } from "../types";

interface FitTabProps {
  result: FitResult;
  currentResume: string;
  onUpdateResult: (updated: FitResult, msg?: string) => void;
}

export const FitTab: React.FC<FitTabProps> = ({ result, currentResume, onUpdateResult }) => {
  const reqs = Array.isArray(result.requirements) ? result.requirements : [];
  const fit = computeFit(result);
  const [detailStates, setDetailStates] = useState<Record<string, { open: boolean; text: string; busy: boolean; res: DetailResult | null; err: string }>>({});

  const getState = (q: Requirement, idx: number) => {
    const key = q._term ? `term_${idx}_${q._term}` : `req_${idx}`;
    return detailStates[key] || { open: false, text: "", busy: false, res: null, err: "" };
  };

  const updateState = (
    q: Requirement,
    idx: number,
    patch: Partial<{ open: boolean; text: string; busy: boolean; res: DetailResult | null; err: string }>
  ) => {
    const key = q._term ? `term_${idx}_${q._term}` : `req_${idx}`;
    setDetailStates((prev) => ({
      ...prev,
      [key]: { ...prev[key], ...patch }
    }));
  };

  const handleImproveFromDetails = async (
    q: Requirement,
    idx: number,
    opts: { mode?: "revise" | "add"; target?: string } = {}
  ) => {
    const d = getState(q, idx);
    const details = (d.text || "").trim();
    if (details.split(/\s+/).length < 6) {
      updateState(q, idx, { err: "Add a sentence or two: what you did, where, and the result." });
      return;
    }

    const list = resumeBulletList(currentResume);
    if (!list.length) {
      updateState(q, idx, { err: "Couldn't find bullet points in your resume. Re-upload it in step 1." });
      return;
    }

    const prev = d.res && d.res.mode !== "need_more" ? d.res : null;
    updateState(q, idx, { busy: true, err: "", res: opts.mode ? d.res : null });

    let forced = "";
    if (opts.mode === "revise") {
      forced = opts.target
        ? `\n- You MUST use mode "revise" with bullet_id "${opts.target}". Rewrite that bullet to include the new details, keeping its other facts.`
        : `\n- You MUST use mode "revise". Pick the existing bullet closest to this work.`;
    } else if (opts.mode === "add") {
      forced = `\n- You MUST use mode "add": a separate new bullet built only from the candidate's details. Don't copy facts from existing bullets.${
        opts.target
          ? ` Use anchor_id "${opts.target}".`
          : " Pick anchor_id: the bullet it should follow (same employer or role)."
      }`;
    }

    const prompt = `A job candidate wants to strengthen one requirement on their resume using experience their resume doesn't show yet.

REQUIREMENT: ${q.requirement} (${isPreferred(q) ? "nice to have" : "required"})
CURRENT STATUS: ${q.status}. ${q.evidence || ""}

WHAT THE CANDIDATE ADDED (their own words; the only new facts you may use):
${details.slice(0, 2000)}

RESUME BULLETS
${list.map((b) => `${b.id}: ${b.text}`).join("\n")}

POSTING TERMS TO USE WHERE TRUTHFUL: ${(result.key_terms || [])
      .filter((k) => k.supported)
      .map((k) => k.term)
      .join(", ") || "none"}

Write ONE resume bullet:
- If one existing bullet covers the same work, revise it to include the new details: mode "revise" and its bullet_id.
- Otherwise write a new bullet: mode "add", and anchor_id is the bullet it should follow (same employer or role).
- Start with a strong verb. 170 characters or fewer. Use only facts from the candidate's details and, for "revise", that one bullet. Never add numbers, tools, or results they didn't give.
- If the details are too vague for a credible bullet (no concrete action, context, or result), use mode "need_more" and ask one short follow-up question in "question".
- new_status: the requirement's status once this bullet is on the resume ("strong", "partial", or "missing"). Never lower than ${q.status}. status_reason: one sentence.
- why: one short sentence on how this addresses the requirement.${
      q._term ? `\n- The bullet must use the exact phrase "${q._term}" (plural or tense changes are fine).` : ""
    }${forced}

Reply with only JSON: {"mode":"revise","bullet_id":"","anchor_id":"","rewritten":"","why":"","new_status":"","status_reason":"","question":""}`;

    try {
      const out = await sample.json(prompt, { modelTier: "default", cache: false });
      if (!out || !["revise", "add", "need_more"].includes(out.mode)) throw { code: "invalid_json" };

      if (out.mode !== "need_more") {
        const mode = opts.mode || out.mode;
        const byId = new Map(list.map((b) => [b.id, b]));
        let id = String(mode === "revise" ? out.bullet_id || out.anchor_id : out.anchor_id || out.bullet_id);
        if (opts.target) id = opts.target;
        const src = byId.get(id) || (prev && prev.srcId && byId.get(prev.srcId)) || list[0];
        const text = String(out.rewritten || "").trim();
        if (!text) throw { code: "empty_completion" };

        const allowed = new Set([...extractNums(details), ...(mode === "revise" ? extractNums(src.text) : [])]);
        const invented = [...extractNums(text)].filter((n) => !allowed.has(n));
        if (invented.length) {
          updateState(q, idx, {
            err: `The draft used a number you didn't give (${invented.join(
              ", "
            )}), so JobFit discarded it. Try again, or add the number to your details if it's real.`,
            res: prev,
            busy: false
          });
          return;
        }

        const resObj: DetailResult = {
          mode,
          srcId: src.id,
          source: src.text,
          rewritten: text,
          why: String(out.why || ""),
          new_status: ["strong", "partial", "missing"].includes(out.new_status) ? out.new_status : q.status,
          status_reason: String(out.status_reason || "")
        };

        const rank: Record<string, number> = { missing: 0, partial: 1, strong: 2 };
        if (rank[resObj.new_status || "missing"] < rank[q.status]) {
          resObj.new_status = q.status;
        }

        updateState(q, idx, { res: resObj, busy: false, err: "" });
      } else {
        updateState(q, idx, {
          res: { mode: "need_more", question: String(out.question || "") },
          busy: false,
          err: ""
        });
      }
    } catch {
      updateState(q, idx, {
        err: "Couldn't write the bullet. Try again.",
        res: prev,
        busy: false
      });
    }
  };

  const handleAcceptDetail = (q: Requirement, idx: number, res: DetailResult) => {
    const updated = { ...result };
    if (!Array.isArray(updated.bullets)) updated.bullets = [];
    syncAccept(updated);

    const b = {
      original: res.mode === "revise" ? res.source || "" : "",
      anchor: res.mode === "add" ? res.source || "" : "",
      mode: res.mode === "add" ? ("add" as const) : ("revise" as const),
      rewritten: (res.rewritten || "").trim(),
      why: res.why || "Addresses: " + q.requirement,
      needs_confirmation: false,
      confirm_note: "",
      from_details: true
    };

    if (b.mode === "revise") {
      const i = updated.bullets.findIndex((x) => x.mode !== "add" && similarity(x.original, b.original) >= 0.8);
      if (i >= 0) {
        updated.bullets.splice(i, 1);
        updated._accept?.splice(i, 1);
      }
    }

    updated.bullets.push(b);
    if (!Array.isArray(updated._accept)) updated._accept = [];
    updated._accept.push(true);

    const targetReq = updated.requirements[idx];
    targetReq._added = {
      rewritten: b.rewritten,
      from: targetReq.status,
      to: res.new_status || targetReq.status,
      prevTip: targetReq.tip,
      prevEvidence: targetReq.evidence
    };
    targetReq.status = res.new_status || targetReq.status;
    targetReq.evidence = (targetReq.evidence ? targetReq.evidence + " " : "") + "Added from your details.";
    delete updated._edited;

    updateState(q, idx, { open: false, text: "", busy: false, res: null, err: "" });
    onUpdateResult(updated, "Added. You'll find it in the Bullets and Tailored resume tabs.");
  };

  const handleUndoDetail = (q: Requirement, idx: number) => {
    const a = q._added;
    if (!a) return;
    const updated = { ...result };
    const i = (updated.bullets || []).findIndex((b) => b.from_details && b.rewritten === a.rewritten);
    if (i >= 0) {
      updated.bullets.splice(i, 1);
      if (Array.isArray(updated._accept)) updated._accept.splice(i, 1);
    }
    const targetReq = updated.requirements[idx];
    targetReq.status = a.from;
    targetReq.evidence = a.prevEvidence;
    targetReq.tip = a.prevTip;
    delete targetReq._added;
    delete updated._edited;
    onUpdateResult(updated);
  };

  const n = normTerm(currentResume);
  const can = (result.key_terms || []).filter((k) => k.supported && !hasTerm(n, k.term)).map((k) => k.term);
  const cant = (result.key_terms || []).filter((k) => !k.supported).map((k) => k.term);
  const reqN = reqs.filter((q) => !isPreferred(q)).length;
  const prefN = reqs.length - reqN;

  const bulletList = resumeBulletList(currentResume);

  return (
    <div className="pane" role="tabpanel">
      <div className="pane-head">
        <p className="tiny">Each requirement from the posting, checked against your resume.</p>
      </div>

      {reqs.length > 0 && (
        <details className="how-score">
          <summary>How this score works</summary>
          <p>
            Each requirement earns full credit if strong, half if partial, none if missing. Required items count
            double. {reqN} required and {prefN} nice-to-have give {fit.earned} of {fit.possible} possible points, so the
            score is {fit.score}.
          </p>
          <p>
            90+ Excellent fit · 80–89 Strong fit · 70–79 Good fit · 55–69 Worth a shot · below 55 Long shot.
          </p>
          {fit.capped && (
            <p className="capnote">
              The label is held at Good fit because a required item is missing:{" "}
              {fit.missingReq.map((q) => q.requirement).join("; ")}.
            </p>
          )}
          <p className="tiny">
            Rewording your resume doesn't change this score, because it measures your experience. Resume match measures
            how clearly your resume shows it.
          </p>
        </details>
      )}

      <ul className="reqs">
        {reqs.map((q, idx) => {
          const st = ["strong", "partial", "missing"].includes(q.status) ? q.status : "partial";
          const d = getState(q, idx);

          return (
            <li key={idx}>
              <span className={`chip ${st}`}>{st}</span>
              <div>
                <div className="req-name">
                  {q.requirement || ""}
                  <span className={`imp ${isPreferred(q) ? "" : "req"}`}>
                    {isPreferred(q) ? "Nice to have" : "Required"}
                  </span>
                </div>
                <div className="evidence">{q.evidence || "Nothing on your resume speaks to this yet."}</div>

                {(st !== "strong" || q._added) && (
                  <div className="tip">
                    {q.tip && (
                      <div>
                        <b>How to address it: </b>
                        {q.tip}
                      </div>
                    )}

                    <div className="det">
                      {q._added ? (
                        <div className="det-done">
                          <strong>Added to your resume</strong>
                          <p>{q._added.rewritten}</p>
                          <span className="tiny">
                            {q._term
                              ? `Your resume now shows “${q._term}”.`
                              : q._added.from !== q._added.to
                              ? `Moved this requirement from ${q._added.from} to ${q._added.to}.`
                              : `The requirement stays ${q._added.to}, and your resume now shows it.`}
                          </span>
                          <button type="button" className="linkbtn" onClick={() => handleUndoDetail(q, idx)}>
                            Undo
                          </button>
                        </div>
                      ) : !d.open ? (
                        <div className="det-cta">
                          <p>
                            <strong>
                              {q._term
                                ? "Have you done this? "
                                : q.status === "missing"
                                ? "Have you done this? "
                                : "Done more than your resume shows? "}
                            </strong>
                            {q._term
                              ? `Describe it, and JobFit writes a bullet that shows “${q._term}”.`
                              : q.status === "missing"
                              ? "Describe it, and JobFit writes a resume bullet for it."
                              : "Describe it, and JobFit rewrites your bullet to prove it."}
                          </p>
                          <button
                            type="button"
                            className="btn primary det-open"
                            onClick={() => updateState(q, idx, { open: true })}
                          >
                            {q.status === "missing" ? "Add it to my resume →" : "Write a stronger bullet →"}
                          </button>
                        </div>
                      ) : (
                        <>
                          <label className="det-l">Your details (only what's true)</label>
                          <textarea
                            className="det-ta"
                            rows={3}
                            value={d.text}
                            placeholder="What did you actually do? Include where, what you did, and the result. For example: At my last job I ran an A/B test on the signup page, and the new version lifted completions by 8%."
                            onChange={(e) => updateState(q, idx, { text: e.target.value })}
                          />
                          <div className="row" style={{ marginTop: "8px" }}>
                            <button
                              type="button"
                              className={d.res && d.res.mode !== "need_more" ? "btn ghost" : "btn primary"}
                              disabled={d.busy}
                              onClick={() => handleImproveFromDetails(q, idx)}
                            >
                              {d.busy && !d.res
                                ? "Writing your bullet…"
                                : d.res && d.res.mode !== "need_more"
                                ? "Rewrite from my details"
                                : "Write my bullet"}
                            </button>
                            <button
                              type="button"
                              className="btn ghost"
                              disabled={d.busy}
                              onClick={() => updateState(q, idx, { open: false, res: null, err: "" })}
                            >
                              Cancel
                            </button>
                          </div>
                          <p className="tiny">
                            JobFit only uses what you write here plus your resume. It won't add numbers or results you
                            didn't give.
                          </p>
                          {d.err && <p className="msg err">{d.err}</p>}

                          {d.res && d.res.mode === "need_more" && (
                            <div className="det-q">
                              {d.res.question || "Add a bit more detail: what you did, where, and what changed as a result."}
                            </div>
                          )}

                          {d.res && d.res.mode !== "need_more" && (
                            <div className={`det-res ${d.busy ? "busy" : ""}`}>
                              <div className="seg" role="radiogroup" aria-label="What to do with this bullet">
                                <button
                                  type="button"
                                  className="seg-b"
                                  role="radio"
                                  aria-checked={d.res.mode === "revise"}
                                  disabled={d.busy}
                                  onClick={() => handleImproveFromDetails(q, idx, { mode: "revise" })}
                                >
                                  Update a bullet
                                </button>
                                <button
                                  type="button"
                                  className="seg-b"
                                  role="radio"
                                  aria-checked={d.res.mode === "add"}
                                  disabled={d.busy}
                                  onClick={() => handleImproveFromDetails(q, idx, { mode: "add" })}
                                >
                                  Add as new bullet
                                </button>
                              </div>

                              <label className="det-where">
                                <span className="mk">
                                  {d.res.mode === "revise" ? "Bullet to update" : "Place it after"}
                                </span>
                                <select
                                  disabled={d.busy}
                                  value={d.res.srcId || (bulletList[0]?.id ?? "")}
                                  onChange={(e) => {
                                    const t = bulletList.find((b) => b.id === e.target.value);
                                    if (!t || !d.res) return;
                                    if (d.res.mode === "add") {
                                      updateState(q, idx, { res: { ...d.res, srcId: t.id, source: t.text } });
                                    } else {
                                      handleImproveFromDetails(q, idx, { mode: "revise", target: t.id });
                                    }
                                  }}
                                >
                                  {bulletList.map((b) => (
                                    <option key={b.id} value={b.id}>
                                      {b.text.length > 110 ? b.text.slice(0, 110) + "…" : b.text}
                                    </option>
                                  ))}
                                </select>
                              </label>

                              <p className="tiny">
                                {d.res.mode === "revise"
                                  ? "The bullet above is rewritten to include your details. Its other facts stay."
                                  : "Your details become a separate bullet, right after the one above. Your existing bullets don't change."}
                              </p>

                              {d.busy ? (
                                <p className="det-busy">Rewriting for this choice…</p>
                              ) : (
                                <>
                                  <span className="mk">
                                    {d.res.mode === "revise" ? "Updated bullet" : "New bullet"}
                                  </span>
                                  <textarea
                                    className="after-edit"
                                    rows={3}
                                    value={d.res.rewritten || ""}
                                    aria-label="Suggested bullet"
                                    onChange={(e) => {
                                      if (d.res) {
                                        updateState(q, idx, { res: { ...d.res, rewritten: e.target.value } });
                                      }
                                    }}
                                  />
                                  {bulletLines(d.res.rewritten || "") > MAX_LINES && (
                                    <div className="lines-inline">
                                      <span className="lc over">
                                        {bulletLines(d.res.rewritten || "")} lines · over the 2-line limit
                                      </span>
                                    </div>
                                  )}

                                  {d.res.why && <p className="tiny">{d.res.why}</p>}

                                  {d.res.new_status && d.res.new_status !== q.status && !q._term && (
                                    <p className="det-gain">
                                      Adding this moves the requirement from {q.status} to {d.res.new_status}.
                                    </p>
                                  )}
                                  {d.res.status_reason && <p className="tiny">{d.res.status_reason}</p>}

                                  <div className="row" style={{ marginTop: "10px" }}>
                                    <button
                                      type="button"
                                      className="btn primary"
                                      onClick={() => d.res && handleAcceptDetail(q, idx, d.res)}
                                    >
                                      {d.res.mode === "revise" ? "Update my resume" : "Add to my resume"}
                                    </button>
                                    <button
                                      type="button"
                                      className="btn ghost"
                                      onClick={() =>
                                        handleImproveFromDetails(q, idx, {
                                          mode: d.res?.mode === "need_more" ? undefined : d.res?.mode,
                                          target: d.res?.srcId
                                        })
                                      }
                                    >
                                      Try again
                                    </button>
                                  </div>
                                </>
                              )}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {Array.isArray(result.key_terms) && result.key_terms.length > 0 ? (
        <>
          {can.length > 0 && (
            <>
              <h3 className="sub">Posting terms you can add</h3>
              <p className="tiny">
                Your experience supports these, but your resume doesn't use the words. Adding them raises your resume
                match.
              </p>
              <div className="kw">
                {can.map((w, i) => (
                  <span key={i} className="can">
                    {w}
                  </span>
                ))}
              </div>
            </>
          )}

          {cant.length > 0 && (
            <>
              <h3 className="sub">Posting terms you can't claim yet</h3>
              <p className="tiny">
                Nothing on your resume supports these. Address them in interviews, not by adding the words.
              </p>
              <div className="kw">
                {cant.map((w, i) => (
                  <span key={i}>{w}</span>
                ))}
              </div>
            </>
          )}
        </>
      ) : (
        Array.isArray(result.keywords_missing) &&
        result.keywords_missing.length > 0 && (
          <>
            <h3 className="sub">Terms the posting uses that your resume doesn't</h3>
            <p className="tiny">Add one only where it's true of your work.</p>
            <div className="kw">
              {result.keywords_missing.map((w, i) => (
                <span key={i}>{w}</span>
              ))}
            </div>
          </>
        )
      )}
    </div>
  );
};
