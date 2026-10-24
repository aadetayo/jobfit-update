import React, { useState } from "react";

interface JobCardProps {
  jd: string;
  url: string;
  loading: boolean;
  onJdChange: (v: string) => void;
  onUrlChange: (v: string) => void;
  onCheckFit: () => void;
  msg: { text: string; err: boolean };
  onClearMsg: () => void;
}

export function cleanUrl(v: string): string {
  v = (v || "").trim();
  if (!v) return "";
  if (!/^https?:\/\//i.test(v) && /^[\w-]+(\.[\w-]+)+(\/|$)/.test(v)) v = "https://" + v;
  try {
    const u = new URL(v);
    return /^https?:$/.test(u.protocol) ? u.href : "";
  } catch {
    return "";
  }
}

export const JobCard: React.FC<JobCardProps> = ({
  jd,
  url,
  loading,
  onJdChange,
  onUrlChange,
  onCheckFit,
  msg,
  onClearMsg
}) => {
  const [hintVisible, setHintVisible] = useState(false);

  const handleUrlInput = (raw: string) => {
    onUrlChange(raw);
    const valid = cleanUrl(raw);
    if (valid && jd.trim().length < 80) {
      setHintVisible(true);
    } else {
      setHintVisible(false);
    }
  };

  const handleJdPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const t = (e.clipboardData?.getData("text") || "").trim();
    if (t && !/\s/.test(t) && cleanUrl(t) && /^(https?:\/\/|www\.)/i.test(t)) {
      e.preventDefault();
      onUrlChange(t);
      setHintVisible(true);
    }
  };

  const handleJdInput = (val: string) => {
    onJdChange(val);
    if (val.trim().length >= 80) {
      setHintVisible(false);
    }
  };

  const handleClear = () => {
    onJdChange("");
    onUrlChange("");
    setHintVisible(false);
    onClearMsg();
  };

  const validUrl = cleanUrl(url);

  return (
    <form
      className="card"
      id="jdForm"
      aria-labelledby="jdH"
      onSubmit={(e) => {
        e.preventDefault();
        onCheckFit();
      }}
    >
      <div className="card-head">
        <div className="step">
          <b id="jdStep">2</b>
          <h2 id="jdH">Job posting</h2>
        </div>
        <button type="button" className="linkbtn" id="clearJd" onClick={handleClear}>
          Clear
        </button>
      </div>

      <label className="lab" htmlFor="jdUrl">
        Link to the posting <span>optional</span>
      </label>
      <div className="urlrow">
        <input
          id="jdUrl"
          type="url"
          inputMode="url"
          autoComplete="off"
          value={url}
          placeholder="Paste a job link, e.g. from LinkedIn or Greenhouse"
          onChange={(e) => handleUrlInput(e.target.value)}
        />
        {validUrl && (
          <a id="openPost" className="btn ghost" href={validUrl} target="_blank" rel="noopener noreferrer">
            Open ↗
          </a>
        )}
      </div>

      {hintVisible && validUrl && (
        <div className="hint" id="urlHint">
          <strong>Now grab the posting in two shortcuts.</strong> Open it, press <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>A</kbd>{" "}
          then <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>C</kbd>, and paste below. Copying the whole page is fine. JobFit finds the job
          details and ignores menus and ads.
        </div>
      )}

      <label className="lab" htmlFor="jd">
        Job description
      </label>
      <textarea
        id="jd"
        placeholder="Paste the job description. The whole page is fine, menus and all."
        spellCheck={false}
        value={jd}
        onChange={(e) => handleJdInput(e.target.value)}
        onPaste={handleJdPaste}
      />

      <div style={{ marginTop: "12px" }}>
        <button type="submit" className="btn primary big" id="go" disabled={loading}>
          {loading ? "Checking…" : "Check my fit"}
        </button>
      </div>

      {msg.text && (
        <div className={`msg ${msg.err ? "err" : ""}`} role="status">
          {msg.text}
        </div>
      )}
    </form>
  );
};
