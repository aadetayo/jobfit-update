import React, { useState } from "react";
import { shortenBullets } from "../services/agent";
import { sample } from "../services/gemini";
import { bulletLines, MAX_LINES, shownText } from "../services/parser";
import { Bullet, FitResult } from "../types";

interface BulletsTabProps {
  result: FitResult;
  onUpdateResult: (updated: FitResult, msg?: string) => void;
  onGoToResumeTab: () => void;
  onStopAgent?: () => void;
}

export const BulletsTab: React.FC<BulletsTabProps> = ({
  result,
  onUpdateResult,
  onGoToResumeTab,
  onStopAgent
}) => {
  const agent = result._agent;
  const running = agent && agent.status === "running";
  const bullets = Array.isArray(result.bullets) ? result.bullets : [];
  const [shorteningIdx, setShorteningIdx] = useState<number | null>(null);
  const [copyStatus, setCopyStatus] = useState<string>("Copy all");

  const handleCopy = async (text: string, cb?: () => void) => {
    try {
      await navigator.clipboard.writeText(text);
      if (cb) cb();
    } catch {}
  };

  const handleCopyAll = () => {
    const text = bullets
      .filter((b) => b.mode !== "append")
      .map((b) => "• " + b.rewritten)
      .join("\n");
    handleCopy(text, () => {
      setCopyStatus("Copied");
      setTimeout(() => setCopyStatus("Copy all"), 1600);
    });
  };

  const handleShorten = async (b: Bullet, idx: number) => {
    setShorteningIdx(idx);
    try {
      const copy = [{ rewritten: b.rewritten }];
      await shortenBullets(copy);
      if (copy[0].rewritten && copy[0].rewritten !== b.rewritten) {
        const updated = { ...result };
        updated.bullets[idx] = { ...b, rewritten: copy[0].rewritten };
        delete updated._edited;
        onUpdateResult(updated);
      }
    } catch {}
    setShorteningIdx(null);
  };

  const labelMap: Record<string, string> = {
    running: "Agent working",
    done: "Agent finished",
    fallback: "Agent couldn't finish · used a single pass",
    failed: "Agent couldn't finish",
    stopped: "Agent stopped"
  };

  return (
    <div className="pane" role="tabpanel">
      {agent && (
        <div className={`agent ${running ? "live" : ""}`}>
          <div className="agent-top">
            <div className="agent-title">
              {running && <span className="dot" />}
              <strong>{labelMap[agent.status] || "Agent"}</strong>
              <span className="tiny">
                {" "}
                · {agent.steps.filter((s) => /^Checked|^Submitted|^Searched/.test(s.text)).length} tool calls
              </span>
            </div>
            {running && (
              <button type="button" className="btn ghost" onClick={onStopAgent}>
                Stop
              </button>
            )}
          </div>

          {running && (
            <ol className="trace">
              {agent.steps.map((s, i) => (
                <li key={i} className={s.ok === true ? "ok" : s.ok === false ? "bad" : ""}>
                  {s.text}
                </li>
              ))}
              <li className="pending">Thinking…</li>
            </ol>
          )}

          {agent.summary && !running && <p className="agent-sum">{agent.summary}</p>}

          {!running && (
            <details>
              <summary>How the agent got here ({agent.steps.length} steps)</summary>
              <p className="tiny agent-goal">
                Goal: bullets that fit two lines and use only facts from your resume. The agent drafts, checks its work
                with JobFit's rules, and revises until everything passes.
              </p>
              <ol className="trace">
                {agent.steps.map((s, i) => (
                  <li key={i} className={s.ok === true ? "ok" : s.ok === false ? "bad" : ""}>
                    {s.text}
                  </li>
                ))}
              </ol>
            </details>
          )}
        </div>
      )}

      {running ? null : (
        <>
          <div className="pane-head">
            <p className="tiny">
              Your most relevant bullets, rewritten in this posting's language. Numbers are kept as you wrote them.
              {bullets.length > 0 && bullets.every((b) => bulletLines(b.rewritten) <= MAX_LINES)
                ? " All fit in two lines."
                : ""}
            </p>
            {bullets.length > 0 && (
              <button type="button" className="copy" onClick={handleCopyAll}>
                {copyStatus}
              </button>
            )}
          </div>

          <div className="bullets">
            {bullets.map((b, idx) => {
              const lines = bulletLines(b.rewritten);
              const overLimit = lines > MAX_LINES;

              return (
                <div key={idx} className="bcard">
                  {b.from_details && <div className="fromdet">From your details</div>}
                  {b.from_terms && <div className="fromdet">Works in posting terms</div>}

                  <div className="before">
                    {b.mode === "add" ? (
                      <>
                        <b>New bullet · added after</b>
                        {b.anchor || ""}
                      </>
                    ) : b.mode === "append" ? (
                      <>
                        <b>Skills line · before</b>
                        {b.original || ""}
                      </>
                    ) : (
                      <>
                        <b>Before</b>
                        {b.original || ""}
                      </>
                    )}
                  </div>

                  <div className="after">
                    <p>{shownText(b) || ""}</p>
                    <button
                      type="button"
                      className="copy"
                      onClick={(e) => {
                        const btn = e.currentTarget;
                        handleCopy(shownText(b) || "", () => {
                          btn.textContent = "Copied";
                          setTimeout(() => (btn.textContent = "Copy"), 1600);
                        });
                      }}
                    >
                      Copy
                    </button>
                  </div>

                  {overLimit && (
                    <div className="lines">
                      <span className="lc over">{lines} lines · over the 2-line limit</span>
                      <button
                        type="button"
                        className="linkbtn"
                        disabled={shorteningIdx === idx}
                        onClick={() => handleShorten(b, idx)}
                      >
                        {shorteningIdx === idx ? "Shortening…" : "Shorten"}
                      </button>
                    </div>
                  )}

                  {b.why && <div className="why">{b.why}</div>}
                  {b.needs_confirmation && (
                    <div className="flag">
                      Check before using: {b.confirm_note || "This adds wording that isn't on your resume."}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {bullets.length > 0 && (
            <button
              type="button"
              className="btn primary"
              style={{ marginTop: "16px" }}
              onClick={onGoToResumeTab}
            >
              Put these in my resume →
            </button>
          )}
        </>
      )}
    </div>
  );
};
