import React, { useEffect, useState } from "react";
import { sample } from "../services/gemini";
import {
  blocksToText,
  buildDocx,
  buildPdf,
  bulletLines,
  editDocx,
  hasTerm,
  matchBullets,
  matchPair,
  MAX_LINES,
  normTerm,
  parseResume,
  resumeFilename,
  saveBlob,
  shownText,
  similarity,
  syncAccept,
  tailoredBlocks
} from "../services/parser";
import { DocxFile, FitResult, ResumeBlock } from "../types";

interface TailoredResumeTabProps {
  result: FitResult;
  currentResume: string;
  docx: DocxFile | null;
  onUpdateResult: (updated: FitResult, msg?: string) => void;
  onOpenResumeUpload: () => void;
}

export const TailoredResumeTab: React.FC<TailoredResumeTabProps> = ({
  result,
  currentResume,
  docx,
  onUpdateResult,
  onOpenResumeUpload
}) => {
  const bullets = Array.isArray(result.bullets) ? result.bullets : [];
  const running = result._agent && result._agent.status === "running";
  const [downloadMsg, setDownloadMsg] = useState<{ text: string; err: boolean } | null>(null);
  const [isWorkingTerms, setIsWorkingTerms] = useState(false);
  const [docScan, setDocScan] = useState<boolean[] | null | "error">(null);
  const [isPreparingDocx, setIsPreparingDocx] = useState(false);
  const [isPreparingPdf, setIsPreparingPdf] = useState(false);

  const docxMode = !result.example && docx && !result._forceClean;

  // Scan Word file if in docxMode
  useEffect(() => {
    if (docxMode && docx?.b64 && bullets.length > 0) {
      editDocx(
        docx.b64,
        bullets.map((b) => ({ original: b.original, rewritten: b.rewritten, mode: b.mode, anchor: b.anchor })),
        { dryRun: true }
      )
        .then(({ found }) => setDocScan(found))
        .catch(() => setDocScan("error"));
    }
  }, [docxMode, docx?.b64, bullets.length]);

  if (!currentResume.trim()) {
    return (
      <div className="pane">
        <p className="muted">Save your resume in step 1 to build a tailored version.</p>
      </div>
    );
  }

  if (running) {
    return (
      <div className="pane">
        <p className="muted">The agent is still writing your bullets. Your tailored resume will be ready here when it finishes.</p>
      </div>
    );
  }

  if (!bullets.length) {
    return (
      <div className="pane">
        <p className="muted">This check has no rewritten bullets to add.</p>
      </div>
    );
  }

  const handleToggleAccept = (k: number, checked: boolean) => {
    const updated = { ...result };
    syncAccept(updated);
    if (!Array.isArray(updated._accept)) updated._accept = [];
    updated._accept[k] = checked;
    delete updated._edited;
    onUpdateResult(updated);
  };

  const handleWorkInTerms = async (terms: string[]) => {
    setIsWorkingTerms(true);
    setDownloadMsg(null);
    syncAccept(result);
    const orig = parseResume(currentResume);
    const isRep = (b: any) => b.mode !== "add" && b.mode !== "append";
    const m = matchBullets(
      orig,
      bullets.map((b) => ({ original: isRep(b) ? b.original : "" }))
    );

    const views: Array<{ id: string; orig: string; text: string; entry: number }> = [];
    let n = 0;
    orig.forEach((blk, i) => {
      if (blk.type !== "bullet") return;
      const k = m.findIndex((x, j) => x === i && isRep(bullets[j]));
      views.push({
        id: "b" + ++n,
        orig: blk.text,
        text: k >= 0 && result._accept?.[k] ? bullets[k].rewritten : blk.text,
        entry: k
      });
    });

    let a = 0;
    bullets.forEach((b, k) => {
      if (b.mode === "add" && result._accept?.[k]) {
        views.push({ id: "n" + ++a, orig: "", text: b.rewritten, entry: k });
      }
    });

    const hi = orig.findIndex((b) => b.type === "heading" && /SKILL/i.test(b.text));
    let skills: string | null = null;
    if (hi >= 0) {
      const nx = orig.slice(hi + 1).find((b) => b.type !== "blank");
      if (nx && nx.type !== "heading" && nx.type !== "bullet") skills = nx.text;
    }

    const unsupported = (result.key_terms || []).filter((k) => !k.supported).map((k) => String(k.term));
    const prompt = `You are tailoring a resume to a job posting. Work these posting terms into the resume, but only where the resume's existing facts truthfully show them.

TERMS TO WORK IN
${terms.join("\n")}

CURRENT BULLETS
${views.map((v) => `${v.id}: ${v.text}`).join("\n")}

${skills ? `SKILLS LINE\n${skills}` : "There is no skills line."}

JOB: ${result.role || ""}

Rules:
- For each term, either revise ONE bullet so it uses the term's exact wording (plural or tense changes are fine), add it to the skills line (only concrete skills, methods, or tools, and only if a skills line exists), or leave it out.
- Only put a term in a bullet whose facts already demonstrate it. Never stretch a bullet to fit a term.
- At most 2 new terms per bullet. Keep each bullet's meaning, every number, and a strong opening verb. 170 characters or fewer per bullet. Add no new facts, numbers, tools, or outcomes.
- Each term you leave out goes in not_placed with a one-sentence reason naming the experience that's missing.

Reply with only JSON: {"edits":[{"bullet_id":"b1","rewritten":"","terms":[""]}],"skills":[""],"not_placed":[{"term":"","reason":""}]}`;

    try {
      const out = await sample.json(prompt, { modelTier: "default", cache: false });
      const updated = { ...result };
      if (!Array.isArray(updated.bullets)) updated.bullets = [];
      syncAccept(updated);

      const byId = new Map(views.map((v) => [v.id, v]));
      const placed = new Set<string>();

      for (const e of Array.isArray(out.edits) ? out.edits : []) {
        const v = byId.get(String(e?.bullet_id));
        if (!v) continue;
        const txt = String(e?.rewritten || "").trim();
        if (!txt || bulletLines(txt) > MAX_LINES) continue;
        const isNew = (t: string) => hasTerm(normTerm(txt), t) && !hasTerm(normTerm(v.text), t);
        const bad = unsupported.some((t) => isNew(t));
        if (bad) continue;
        const got = terms.filter((t) => isNew(t));
        if (!got.length) continue;
        got.forEach((t) => placed.add(t));

        if (v.entry >= 0) {
          updated.bullets[v.entry].rewritten = txt;
          updated.bullets[v.entry].from_terms = true;
          if (updated._accept) updated._accept[v.entry] = true;
        } else {
          updated.bullets.push({
            original: v.orig,
            rewritten: txt,
            why: "Works in: " + got.join(", "),
            needs_confirmation: false,
            confirm_note: "",
            from_terms: true
          });
          updated._accept?.push(true);
        }
      }

      if (skills) {
        const add = (Array.isArray(out.skills) ? out.skills : [])
          .map(String)
          .filter(
            (t: string) =>
              terms.some((x: string) => normTerm(x) === normTerm(t)) &&
              !placed.has(t) &&
              !hasTerm(normTerm(skills || ""), t)
          );
        if (add.length) {
          const ex = updated.bullets.findIndex((b) => b.mode === "append" && similarity(b.original, skills || "") >= 0.8);
          if (ex >= 0) {
            updated.bullets[ex].rewritten += ", " + add.join(", ");
            if (updated._accept) updated._accept[ex] = true;
          } else {
            updated.bullets.push({
              mode: "append",
              original: skills,
              rewritten: ", " + add.join(", "),
              why: "Adds posting terms to your skills line",
              needs_confirmation: false,
              confirm_note: "",
              from_terms: true
            });
            updated._accept?.push(true);
          }
          add.forEach((t: string) => placed.add(t));
        }
      }

      updated._termRun = { placed: [...(updated._termRun?.placed || []), ...placed] };
      delete updated._edited;
      onUpdateResult(updated, placed.size ? `Worked in ${placed.size} term${placed.size > 1 ? "s" : ""}.` : "None could be worked in honestly.");
    } catch {
      setDownloadMsg({ text: "Couldn't work the terms in. Try again.", err: true });
    } finally {
      setIsWorkingTerms(false);
    }
  };

  const handleDownloadOwnDocx = async () => {
    if (!docx?.b64 || !Array.isArray(docScan)) return;
    setIsPreparingDocx(true);
    setDownloadMsg(null);
    try {
      const reps = bullets
        .filter((_, k) => docScan[k] && result._accept?.[k])
        .map((b) => ({ original: b.original, rewritten: b.rewritten.trim(), mode: b.mode, anchor: b.anchor }));
      const { blob, found } = await editDocx(docx.b64, reps);
      if (blob) {
        const base = String(docx.name || "Resume.docx").replace(/\.docx$/i, "");
        const co = String(result.role || "").split("·").pop()?.trim() || "";
        const filename = (co && co !== result.role ? `${base} - ${co}` : `${base} - tailored`).replace(/[\\/:*?"<>|]+/g, "").slice(0, 120) + ".docx";
        saveBlob(filename, blob);
        const missed = found.filter((f) => !f).length;
        setDownloadMsg({
          text: missed
            ? `Downloaded. ${missed} bullet${missed > 1 ? "s" : ""} couldn't be placed; copy by hand.`
            : "Downloaded with your formatting. Only the accepted bullets changed.",
          err: false
        });
      }
    } catch {
      setDownloadMsg({ text: "Couldn't update your Word file. Re-upload or use clean layout.", err: true });
    } finally {
      setIsPreparingDocx(false);
    }
  };

  const handleDownloadClean = async (kind: "docx" | "pdf", blocks: ResumeBlock[]) => {
    if (kind === "docx") setIsPreparingDocx(true);
    else setIsPreparingPdf(true);
    setDownloadMsg(null);

    try {
      const blob = kind === "docx" ? await buildDocx(blocks) : await buildPdf(blocks);
      const filename = resumeFilename(result, blocks, kind);
      saveBlob(filename, blob);
      setDownloadMsg({ text: "Downloaded. Open it and adjust styling if you like.", err: false });
    } catch {
      setDownloadMsg({ text: "Couldn't create the file. Use Copy text instead.", err: true });
    } finally {
      setIsPreparingDocx(false);
      setIsPreparingPdf(false);
    }
  };

  const mp = matchPair(result, currentResume);
  const editing = typeof result._edited === "string";

  // Render docx mode
  if (docxMode) {
    const scanOk = Array.isArray(docScan);
    const n = bullets.filter((_, k) => scanOk && docScan[k] && result._accept?.[k]).length;

    return (
      <div className="pane" role="tabpanel">
        <div className="docx-head">
          <span className="docx-ic">W</span>
          <div>
            <strong>{docx.name || "Your resume.docx"}</strong>
            <span className="tiny">
              Your Word file. Only the bullets you accept change; fonts, spacing, and layout stay exactly as they are.
            </span>
          </div>
        </div>

        {mp && (
          <div className="matchpanel">
            <div className="mp-nums">
              <span className="mk">Resume match</span>
              <strong>{mp.before.pct}%</strong>
              {mp.after && mp.after.pct !== mp.before.pct && (
                <>
                  <span className="arrow">→</span>
                  <strong className="up">{mp.after.pct}%</strong>
                </>
              )}
            </div>
            <div className="mp-bar">
              <i className="was" style={{ width: mp.before.pct + "%" }} />
              <i className="now" style={{ width: (mp.after?.pct ?? mp.before.pct) + "%" }} />
            </div>
          </div>
        )}

        {docScan === null && <p className="muted">Finding your bullets in the Word file…</p>}
        {docScan === "error" && (
          <div>
            <p className="msg err">Couldn't read your Word file. Re-upload it in step 1, or use the clean layout.</p>
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                const updated = { ...result, _forceClean: true };
                onUpdateResult(updated);
              }}
            >
              Use clean layout
            </button>
          </div>
        )}

        {scanOk && (
          <>
            <div className="changes">
              {bullets.map((b, k) => {
                const ok = Boolean(docScan[k]);
                const isChecked = ok && Boolean(result._accept?.[k]);

                return (
                  <div key={k} className={`change ${isChecked ? "on" : ""} ${ok ? "" : "missing"}`}>
                    <label className="change-top">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        disabled={!ok}
                        onChange={(e) => handleToggleAccept(k, e.target.checked)}
                      />
                      <span>
                        {ok
                          ? isChecked
                            ? "Will be replaced in your file"
                            : "Keep the original"
                          : "Not found in your Word file, so it won't change"}
                      </span>
                    </label>

                    <div className="before">
                      {b.mode === "add" ? (
                        <>
                          <b>New bullet · added after</b>
                          {b.anchor || ""}
                        </>
                      ) : (
                        <>
                          <b>Before</b>
                          {b.original || ""}
                        </>
                      )}
                    </div>

                    <textarea
                      className="after-edit"
                      rows={3}
                      disabled={!ok}
                      value={b.rewritten || ""}
                      onChange={(e) => {
                        const updated = { ...result };
                        updated.bullets[k] = { ...b, rewritten: e.target.value };
                        onUpdateResult(updated);
                      }}
                    />

                    {bulletLines(b.rewritten || "") > MAX_LINES && (
                      <div className="lines-inline">
                        <span className="lc over">
                          {bulletLines(b.rewritten || "")} lines · over the 2-line limit
                        </span>
                      </div>
                    )}

                    {b.needs_confirmation && (
                      <div className="flag">Check before using: {b.confirm_note || "Adds wording"}</div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="row" style={{ marginTop: "16px" }}>
              <button
                type="button"
                className="btn primary"
                disabled={!n || isPreparingDocx}
                onClick={handleDownloadOwnDocx}
              >
                {isPreparingDocx ? "Preparing…" : `Download my Word file · ${n} change${n === 1 ? "" : "s"}`}
              </button>
              <button
                type="button"
                className="copy"
                onClick={async (e) => {
                  const btn = e.currentTarget;
                  const text = bullets
                    .filter((_, k) => docScan[k] && result._accept?.[k])
                    .map((b) => "• " + b.rewritten)
                    .join("\n");
                  await navigator.clipboard.writeText(text);
                  btn.textContent = "Copied";
                  setTimeout(() => (btn.textContent = "Copy bullets"), 1600);
                }}
              >
                Copy bullets
              </button>
            </div>

            {downloadMsg && (
              <div className={`msg ${downloadMsg.err ? "err" : ""}`} role="status">
                {downloadMsg.text}
              </div>
            )}

            <p className="tiny" style={{ marginTop: "12px" }}>
              Need a PDF? Open the downloaded file in Word or Google Docs and export it.
            </p>
            <button
              type="button"
              className="linkbtn"
              onClick={() => {
                const updated = { ...result, _forceClean: true };
                onUpdateResult(updated);
              }}
            >
              Use the clean layout instead
            </button>
          </>
        )}
      </div>
    );
  }

  // Clean layout mode
  const { blocks, map } = tailoredBlocks(result, currentResume);
  const used = result._accept?.filter((a, k) => a && map[k] >= 0).length || 0;
  const currentBlocks = editing ? parseResume(result._edited || "") : blocks;

  const aMatch = mp?.after || mp?.before;
  const freshTerms = aMatch ? aMatch.unused : [];

  return (
    <div className="pane" role="tabpanel">
      <div className="pane-head">
        <p className="tiny">Your resume with the rewrites you accept, in a clean, simple layout.</p>
      </div>

      {mp && (
        <div className="matchpanel">
          <div className="mp-nums">
            <span className="mk">Resume match</span>
            <strong>{mp.before.pct}%</strong>
            {mp.after && mp.after.pct !== mp.before.pct && (
              <>
                <span className="arrow">→</span>
                <strong className="up">{mp.after.pct}%</strong>
              </>
            )}
          </div>
          <div className="mp-bar">
            <i className="was" style={{ width: mp.before.pct + "%" }} />
            <i className="now" style={{ width: (mp.after?.pct ?? mp.before.pct) + "%" }} />
          </div>
          <p>
            {mp.after && mp.after.pct > mp.before.pct
              ? `Your resume now uses ${mp.after.hit} of the posting's ${mp.after.total} key terms, up from ${mp.before.hit}. Your fit score stays the same: rewording shows your experience more clearly, it doesn't change it.`
              : `Your resume uses ${mp.before.hit} of the posting's ${mp.before.total} key terms you can honestly claim.`}
          </p>

          {freshTerms.length > 0 && (
            <div className="mp-work">
              <p>Not used yet, but true of your work: {freshTerms.join(", ")}.</p>
              <button
                type="button"
                className="btn primary"
                disabled={isWorkingTerms}
                onClick={() => handleWorkInTerms(freshTerms)}
              >
                {isWorkingTerms ? "Working them in…" : `Work ${freshTerms.length > 1 ? "these" : "it"} in for me →`}
              </button>
            </div>
          )}
        </div>
      )}

      <div className="keepfmt">
        <strong>Want to keep your own formatting?</strong>
        <span>
          Upload your resume as a Word file (.docx) in step 1. JobFit will then change only these bullets inside your file.
        </span>
        <button type="button" className="btn ghost" onClick={onOpenResumeUpload}>
          Upload Word file
        </button>
      </div>

      <div className="picks">
        {bullets.map((b, k) => {
          const matched = map[k] >= 0;
          const isChecked = Boolean(result._accept?.[k]) && matched;

          return (
            <label key={k} className={`pick ${matched ? "" : "nomatch"}`}>
              <input
                type="checkbox"
                checked={isChecked}
                disabled={!matched || editing}
                onChange={(e) => handleToggleAccept(k, e.target.checked)}
              />
              <span className="pick-t">
                <span>{shownText(b) || ""}</span>
                {!matched ? (
                  <em>Couldn't find where this goes in your resume. Copy it from the Bullets tab.</em>
                ) : b.mode === "add" ? (
                  <em>New bullet from your details, added after: {(b.anchor || "").slice(0, 90)}…</em>
                ) : b.needs_confirmation ? (
                  <em className="warnt">Check before using: {b.confirm_note || "adds new wording"}</em>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>

      <div className="row spread" style={{ margin: "16px 0 10px" }}>
        <strong>
          {used} of {bullets.length} rewrites applied
        </strong>
        <button
          type="button"
          className="linkbtn"
          onClick={() => {
            const updated = { ...result };
            if (editing) {
              delete updated._edited;
            } else {
              updated._edited = blocksToText(blocks);
            }
            onUpdateResult(updated);
          }}
        >
          {editing ? "Undo my text edits" : "Edit text"}
        </button>
      </div>

      {editing ? (
        <>
          <textarea
            id="tailoredText"
            rows={18}
            spellCheck={true}
            value={result._edited || ""}
            onChange={(e) => {
              const updated = { ...result, _edited: e.target.value };
              onUpdateResult(updated);
            }}
          />
          <p className="tiny">Lines starting with "- " become bullets. Lines in capitals become section headings.</p>
        </>
      ) : (
        <div className="paper" aria-label="Preview of tailored resume">
          {blocks.map((b, i) => {
            if (b.type === "blank") return null;
            if (b.type === "bullet") {
              return (
                <li key={i} className={`pv-bullet ${b.changed ? "changed" : ""}`}>
                  {b.text}
                </li>
              );
            }
            return (
              <div key={i} className={`pv-${b.type} ${b.changed ? "changed" : ""}`}>
                {b.text}
              </div>
            );
          })}
        </div>
      )}

      <div className="row" style={{ marginTop: "14px" }}>
        <button
          type="button"
          className="btn primary"
          disabled={isPreparingDocx}
          onClick={() => handleDownloadClean("docx", currentBlocks)}
        >
          {isPreparingDocx ? "Preparing…" : "Download Word"}
        </button>
        <button
          type="button"
          className="btn ghost"
          disabled={isPreparingPdf}
          onClick={() => handleDownloadClean("pdf", currentBlocks)}
        >
          {isPreparingPdf ? "Preparing…" : "Download PDF"}
        </button>
        <button
          type="button"
          className="copy"
          onClick={async (e) => {
            const btn = e.currentTarget;
            await navigator.clipboard.writeText(blocksToText(currentBlocks));
            btn.textContent = "Copied";
            setTimeout(() => (btn.textContent = "Copy text"), 1600);
          }}
        >
          Copy text
        </button>
      </div>

      {downloadMsg && (
        <div className={`msg ${downloadMsg.err ? "err" : ""}`} role="status">
          {downloadMsg.text}
        </div>
      )}

      {result.example && (
        <p className="tiny" style={{ marginTop: "10px" }}>
          This is the sample candidate's resume. Run a check with your own resume to download yours.
        </p>
      )}
    </div>
  );
};
