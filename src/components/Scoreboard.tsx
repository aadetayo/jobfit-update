import React, { useEffect, useState } from "react";
import { computeFit, matchPair } from "../services/parser";
import { FitResult } from "../types";

interface ScoreboardProps {
  result: FitResult;
  currentResume: string;
  celebrate: boolean;
  currentUrl?: string;
  onGoToResumeTab: () => void;
}

export const Scoreboard: React.FC<ScoreboardProps> = ({
  result,
  currentResume,
  celebrate,
  currentUrl,
  onGoToResumeTab
}) => {
  const fit = computeFit(result);
  const [displayScore, setDisplayScore] = useState(celebrate ? 0 : fit.score);

  useEffect(() => {
    let reduce = false;
    try {
      reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {}

    if (celebrate && !reduce) {
      const t0 = performance.now();
      let reqId: number;
      const tick = (t: number) => {
        const p = Math.min(1, (t - t0) / 800);
        setDisplayScore(Math.round(fit.score * (1 - Math.pow(1 - p, 3))));
        if (p < 1) {
          reqId = requestAnimationFrame(tick);
        }
      };
      reqId = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(reqId);
    } else {
      setDisplayScore(fit.score);
    }
  }, [celebrate, fit.score]);

  const reqs = Array.isArray(result.requirements) ? result.requirements : [];
  const cnt = (k: string) => reqs.filter((q) => q.status === k).length;
  const mp = matchPair(result, currentResume);

  return (
    <div className="summary">
      <div className="board" role="img" aria-label={`Fit score ${fit.score} out of 100: ${fit.lab}`}>
        <div className="k">Fit score</div>
        <div className="n">
          <span>{displayScore}</span>
          <small>/100</small>
        </div>
        <span className={`stamp ${fit.cls}`}>{fit.lab}</span>
      </div>

      <div style={{ minWidth: 0 }}>
        {result.example && <span className="example">Example · sample candidate</span>}
        <p className="role">{result.role || "Untitled role"}</p>
        <p className="verdict">{result.verdict || ""}</p>

        {reqs.length > 0 && (
          <div className="mix" aria-hidden="true">
            {cnt("strong") > 0 && <i className="s" style={{ flex: String(cnt("strong")) }} />}
            {cnt("partial") > 0 && <i className="p" style={{ flex: String(cnt("partial")) }} />}
            {cnt("missing") > 0 && <i className="m" style={{ flex: String(cnt("missing")) }} />}
          </div>
        )}

        <div className="counts">
          <span className="s">
            <i />
            {cnt("strong")} Strong
          </span>
          <span className="p">
            <i />
            {cnt("partial")} Partial
          </span>
          <span className="m">
            <i />
            {cnt("missing")} Missing
          </span>
          {currentUrl && !result.example && (
            <a className="postlink" href={currentUrl} target="_blank" rel="noopener noreferrer">
              View posting ↗
            </a>
          )}
        </div>

        {mp && (
          <button
            type="button"
            className="matchrow"
            title="Share of the posting's key terms your resume uses, counting only skills you actually have."
            onClick={onGoToResumeTab}
          >
            <span className="mk">Resume match</span>
            <strong>{mp.before.pct}%</strong>
            {mp.after && mp.after.pct > mp.before.pct ? (
              <>
                <span className="arrow">→</span>
                <strong className="up">{mp.after.pct}%</strong>
                <span className="tiny">with your rewrites</span>
              </>
            ) : (
              <span className="tiny">
                {mp.before.hit} of {mp.before.total} key terms
              </span>
            )}
          </button>
        )}
      </div>
    </div>
  );
};
