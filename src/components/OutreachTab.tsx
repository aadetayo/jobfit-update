import React, { useState } from "react";
import { sample } from "../services/gemini";
import { FitResult } from "../types";

interface OutreachTabProps {
  result: FitResult;
  onUpdateResult: (updated: FitResult) => void;
}

export const OutreachTab: React.FC<OutreachTabProps> = ({ result, onUpdateResult }) => {
  const outreach = result.outreach || { to: "", message: "" };
  const [isRetoning, setIsRetoning] = useState(false);
  const [toneMsg, setToneMsg] = useState<{ text: string; err: boolean } | null>(null);

  const handleRetone = async (how: string) => {
    const original = outreach.message || "";
    if (!original.trim()) return;
    setIsRetoning(true);
    setToneMsg({ text: "Rewriting…", err: false });

    try {
      const { text } = await sample(
        `Rewrite this outreach note to be ${how}. Keep every fact, keep the [Name] and [Your name] placeholders, and add nothing new. Reply with only the rewritten note.\n\n${original}`,
        {
          modelTier: "quick",
          cache: false,
          onText: ({ text: streaming }) => {
            const updated = { ...result, outreach: { ...outreach, message: streaming } };
            onUpdateResult(updated);
          }
        }
      );
      const updated = { ...result, outreach: { ...outreach, message: text.trim() } };
      onUpdateResult(updated);
      setToneMsg({ text: "Rewritten. Edit it freely before copying.", err: false });
    } catch {
      setToneMsg({ text: "Couldn't rewrite the note. Try again.", err: true });
    } finally {
      setIsRetoning(false);
    }
  };

  return (
    <div className="pane" role="tabpanel">
      <div className="pane-head">
        <p className="tiny">{outreach.to ? "Send to: " + outreach.to : "A short note to someone on the hiring team."}</p>
      </div>

      <textarea
        id="note"
        rows={9}
        value={outreach.message || ""}
        onChange={(e) => {
          const updated = { ...result, outreach: { ...outreach, message: e.target.value } };
          onUpdateResult(updated);
        }}
      />

      <div className="row spread" style={{ marginTop: "10px" }}>
        <div className="tones">
          {[
            ["Shorter", "shorter, under 70 words"],
            ["Warmer", "warmer and more personal"],
            ["More formal", "more formal"]
          ].map(([lab, how]) => (
            <button
              key={lab}
              type="button"
              className="btn ghost"
              disabled={isRetoning}
              onClick={() => handleRetone(how)}
            >
              {lab}
            </button>
          ))}
        </div>

        <button
          type="button"
          className="copy"
          onClick={async (e) => {
            const btn = e.currentTarget;
            await navigator.clipboard.writeText(outreach.message || "");
            btn.textContent = "Copied";
            setTimeout(() => (btn.textContent = "Copy note"), 1600);
          }}
        >
          Copy note
        </button>
      </div>

      {toneMsg && (
        <div className={`msg ${toneMsg.err ? "err" : ""}`} role="status">
          {toneMsg.text}
        </div>
      )}
    </div>
  );
};
