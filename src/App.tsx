import React, { useEffect, useRef, useState } from "react";
import { BulletsTab } from "./components/BulletsTab";
import { FitTab } from "./components/FitTab";
import { Header } from "./components/Header";
import { cleanUrl, JobCard } from "./components/JobCard";
import { OutreachTab } from "./components/OutreachTab";
import { ResumeCard } from "./components/ResumeCard";
import { SavedChecks } from "./components/SavedChecks";
import { Scoreboard } from "./components/Scoreboard";
import { ShareModal } from "./components/ShareModal";
import { TailoredResumeTab } from "./components/TailoredResumeTab";
import { EXAMPLE_JD, EXAMPLE_RESULT } from "./data/example";
import { buildPrompt, fallbackBullets, runBulletAgent, shortenBullets } from "./services/agent";
import { ERR, sample } from "./services/gemini";
import { bulletLines, MAX_LINES } from "./services/parser";
import { store } from "./services/storage";
import { DocxFile, FitResult, SavedCheck } from "./types";

export const App: React.FC = () => {
  const [resume, setResume] = useState<string>(
    () => store.get("cb.resume") ?? store.get("rf.resume") ?? ""
  );
  const [editingResume, setEditingResume] = useState<boolean>(() => !resume.trim());
  const [history, setHistory] = useState<SavedCheck[]>(() => store.json("cb.history", []));
  const [currentId, setCurrentId] = useState<string | null>(() => history[0]?.id ?? null);
  const [result, setResult] = useState<FitResult>(() => history[0]?.result ?? EXAMPLE_RESULT);
  const [jd, setJd] = useState<string>(() => store.get("cb.jd") ?? EXAMPLE_JD);
  const [url, setUrl] = useState<string>(() => store.get("cb.url") ?? "");
  const [docx, setDocx] = useState<DocxFile | null>(() => store.json("cb.docx", null));
  const [docxSaved, setDocxSaved] = useState<boolean>(true);
  const [tab, setTab] = useState<"fit" | "bullets" | "resume" | "outreach">("fit");
  const [loading, setLoading] = useState<boolean>(false);
  const [elapsed, setElapsed] = useState<number>(0);
  const [celebrate, setCelebrate] = useState<boolean>(false);
  const [shareOpen, setShareOpen] = useState<boolean>(false);
  const [msg, setMsg] = useState<{ text: string; err: boolean }>({ text: "", err: false });
  const [accessError, setAccessError] = useState<boolean>(false);

  const abortCtrlRef = useRef<AbortController | null>(null);
  const timerRef = useRef<any>(null);

  const isReturning = Boolean(resume.trim() || history.length > 0);

  // Sync body returning class
  useEffect(() => {
    document.body.classList.toggle("returning", isReturning);
  }, [isReturning]);

  const persistCurrentResult = (newResult: FitResult) => {
    setResult(newResult);
    if (currentId) {
      setHistory((prev) => {
        const next = prev.map((h) => (h.id === currentId ? { ...h, result: newResult } : h));
        store.setJson("cb.history", next);
        return next;
      });
    }
  };

  const handleSaveResume = (newText: string, newDocx: DocxFile | null) => {
    setResume(newText);
    store.set("cb.resume", newText);
    setDocx(newDocx);
    if (newDocx) {
      const saved = store.setJson("cb.docx", newDocx);
      setDocxSaved(saved);
    } else {
      store.remove("cb.docx");
      setDocxSaved(true);
    }
    setEditingResume(false);
    setMsg({ text: "", err: false });
  };

  const handleSelectCheck = (check: SavedCheck) => {
    setCurrentId(check.id);
    setResult(check.result);
    setTab("fit");
    if (check.jd) {
      setJd(check.jd);
      store.set("cb.jd", check.jd);
    }
    setUrl(check.url || "");
    store.set("cb.url", check.url || "");
    setMsg({ text: "", err: false });
  };

  const handleDeleteCheck = (id: string) => {
    const next = history.filter((x) => x.id !== id);
    setHistory(next);
    store.setJson("cb.history", next);
    if (currentId === id) {
      if (next.length) {
        setCurrentId(next[0].id);
        setResult(next[0].result);
      } else {
        setCurrentId(null);
        setResult(EXAMPLE_RESULT);
      }
    }
  };

  const handleCheckFit = async () => {
    setMsg({ text: "", err: false });
    if (editingResume || !resume.trim()) {
      setMsg({ text: "Save your resume first (step 1).", err: true });
      return;
    }
    const trimmedJd = jd.trim();
    if (trimmedJd.length < 80) {
      if (cleanUrl(url)) {
        setMsg({ text: "Open the posting and paste its text in the box. JobFit can't read web pages on its own.", err: true });
      } else {
        setMsg({ text: "Paste the job description first, or a link to it.", err: true });
      }
      return;
    }

    const lim = await sample.limits().catch(() => null);
    const canAgent = Boolean(lim && lim.tools);

    const ctl = new AbortController();
    abortCtrlRef.current = ctl;
    const signal = ctl.signal;

    setLoading(true);
    setElapsed(0);
    const prevResult = result;

    const t0 = Date.now();
    timerRef.current = setInterval(() => {
      setElapsed(Math.round((Date.now() - t0) / 1000));
    }, 1000);

    let res: FitResult;
    try {
      res = await sample.json(buildPrompt(trimmedJd, resume, !canAgent), { signal, modelTier: "default" });
      if (!res || !Array.isArray(res.requirements)) throw { code: "invalid_json" };
      if (!res.requirements.length) {
        setResult(prevResult);
        setLoading(false);
        clearInterval(timerRef.current);
        setMsg({ text: "No job posting found in that text. Open the posting and paste its text again.", err: true });
        return;
      }

      if (canAgent) {
        res.bullets = [];
        res._agent = { status: "running", steps: [], summary: "" };
      } else if (Array.isArray(res.bullets) && res.bullets.some((b) => bulletLines(b.rewritten) > MAX_LINES)) {
        const over = res.bullets.filter((b) => bulletLines(b.rewritten) > MAX_LINES);
        await shortenBullets(over, signal).catch(() => {});
      }

      const h: SavedCheck = {
        id: String(Date.now()),
        at: new Date().toISOString(),
        jd: trimmedJd,
        url: cleanUrl(url),
        resume,
        docxId: docx ? docx.id : null,
        result: res
      };

      const newHistory = [h, ...history.slice(0, 24)];
      setHistory(newHistory);
      store.setJson("cb.history", newHistory);
      setCurrentId(h.id);
      setResult(res);
      setTab("fit");
      setCelebrate(true);
    } catch (err: any) {
      clearInterval(timerRef.current);
      setLoading(false);
      setResult(prevResult);
      if (err && err.code === "cancelled") {
        setMsg({ text: "Stopped. Nothing was saved.", err: false });
      } else {
        setMsg({ text: ERR[err && err.code] || "Something went wrong on the AI's side. Try again.", err: true });
      }
      return;
    }

    clearInterval(timerRef.current);

    if (!canAgent) {
      setLoading(false);
      setMsg({ text: "Saved to your checks.", err: false });
      return;
    }

    setMsg({ text: "Fit report ready. The agent is writing your bullets now.", err: false });

    // Launch agent execution
    try {
      const ok = await runBulletAgent(
        res,
        trimmedJd,
        resume,
        (text, stepOk) => {
          if (!res._agent) res._agent = { status: "running", steps: [], summary: "" };
          res._agent.steps.push({ text, ok: stepOk });
          persistCurrentResult({ ...res });
        },
        signal
      );

      if (!ok) {
        if (!res._agent) res._agent = { status: "running", steps: [], summary: "" };
        res._agent.steps.push({ text: "Switching to a single-pass rewrite instead.", ok: null });
        await fallbackBullets(res, trimmedJd, resume, signal);
        res._agent.status = "fallback";
      }

      persistCurrentResult({ ...res });
      setMsg({ text: "Done. Bullets are ready and saved to your checks.", err: false });
    } catch (err: any) {
      if (res._agent && res._agent.status === "running") {
        res._agent.status = err && err.code === "cancelled" ? "stopped" : "failed";
      }
      persistCurrentResult({ ...res });
      setMsg({
        text:
          err && err.code === "cancelled"
            ? "Agent stopped. Your fit report is saved."
            : ERR[err && err.code] || "The agent couldn't finish. Your fit report is saved.",
        err: !(err && err.code === "cancelled")
      });
    } finally {
      setLoading(false);
    }
  };

  const handleStop = () => {
    if (abortCtrlRef.current) {
      abortCtrlRef.current.abort();
    }
  };

  const currentResumeText = result.example
    ? resume || ""
    : history.find((x) => x.id === currentId)?.resume || resume;

  const agentRunning = result._agent && result._agent.status === "running";
  const reqsCount = (result.requirements || []).length;
  const bulletsCount = agentRunning ? "…" : (result.bullets || []).length;

  return (
    <>
      <Header isReturning={isReturning} onOpenShare={() => setShareOpen(true)} />

      <ShareModal isOpen={shareOpen} onClose={() => setShareOpen(false)} />

      <main className="desk gutter">
        <div className="inner">
          <div className="grid">
            <div className="rail">
              {accessError && (
                <section className="access" role="status">
                  <strong>JobFit can't reach its AI right now</strong>
                  <p>Reload the page and try again in a minute. If it keeps happening, let the person who shared JobFit know.</p>
                </section>
              )}

              <ResumeCard
                resume={resume}
                editingResume={editingResume}
                docx={docx}
                docxSaved={docxSaved}
                onSaveResume={handleSaveResume}
                onStartEditing={() => setEditingResume(true)}
                onCancelEditing={() => setEditingResume(false)}
              />

              <JobCard
                jd={jd}
                url={url}
                loading={loading}
                onJdChange={(v) => {
                  setJd(v);
                  store.set("cb.jd", v);
                }}
                onUrlChange={(v) => {
                  setUrl(v);
                  store.set("cb.url", v);
                }}
                onCheckFit={handleCheckFit}
                msg={msg}
                onClearMsg={() => setMsg({ text: "", err: false })}
              />

              <SavedChecks
                history={history}
                currentId={currentId}
                onSelectCheck={handleSelectCheck}
                onDeleteCheck={handleDeleteCheck}
              />
            </div>

            <div className={`report ${celebrate ? "celebrate" : ""}`} aria-live="polite">
              {loading ? (
                <div className="loading">
                  <div className="row spread">
                    <div>
                      <h3>Checking your fit…</h3>
                      <p className="tiny" id="elapsed">
                        {elapsed}s · usually 20 to 40 seconds
                      </p>
                    </div>
                    <button type="button" className="btn ghost" onClick={handleStop}>
                      Stop
                    </button>
                  </div>

                  <div className="row" style={{ marginTop: "18px", alignItems: "flex-start", flexWrap: "nowrap" }}>
                    <div className="sk big" />
                    <div style={{ flex: 1 }}>
                      {[70, 95, 55].map((w, i) => (
                        <div key={i} className="sk" style={{ width: w + "%" }} />
                      ))}
                    </div>
                  </div>

                  {[60, 77, 85, 68, 72].map((w, i) => (
                    <div key={i} className="sk" style={{ width: w + "%", marginTop: "18px" }} />
                  ))}
                </div>
              ) : (
                <>
                  <Scoreboard
                    result={result}
                    currentResume={currentResumeText}
                    celebrate={celebrate}
                    currentUrl={history.find((x) => x.id === currentId)?.url}
                    onGoToResumeTab={() => setTab("resume")}
                  />

                  {agentRunning && tab === "fit" && (
                    <button type="button" className="agent-banner" onClick={() => setTab("bullets")}>
                      <span className="dot" />
                      Agent is writing your bullets. Watch it work →
                    </button>
                  )}

                  <div className="tabs" role="tablist">
                    <button
                      type="button"
                      className="tab"
                      role="tab"
                      aria-selected={tab === "fit"}
                      onClick={() => setTab("fit")}
                    >
                      Fit {reqsCount > 0 && <em>{reqsCount}</em>}
                    </button>
                    <button
                      type="button"
                      className="tab"
                      role="tab"
                      aria-selected={tab === "bullets"}
                      onClick={() => setTab("bullets")}
                    >
                      Bullets <em>{bulletsCount}</em>
                    </button>
                    <button
                      type="button"
                      className="tab"
                      role="tab"
                      aria-selected={tab === "resume"}
                      onClick={() => setTab("resume")}
                    >
                      Tailored resume
                    </button>
                    <button
                      type="button"
                      className="tab"
                      role="tab"
                      aria-selected={tab === "outreach"}
                      onClick={() => setTab("outreach")}
                    >
                      Outreach
                    </button>
                  </div>

                  {tab === "fit" && (
                    <FitTab
                      result={result}
                      currentResume={currentResumeText}
                      onUpdateResult={(updated, newMsg) => {
                        persistCurrentResult(updated);
                        if (newMsg) setMsg({ text: newMsg, err: false });
                      }}
                    />
                  )}

                  {tab === "bullets" && (
                    <BulletsTab
                      result={result}
                      onUpdateResult={(updated, newMsg) => {
                        persistCurrentResult(updated);
                        if (newMsg) setMsg({ text: newMsg, err: false });
                      }}
                      onGoToResumeTab={() => setTab("resume")}
                      onStopAgent={handleStop}
                    />
                  )}

                  {tab === "resume" && (
                    <TailoredResumeTab
                      result={result}
                      currentResume={currentResumeText}
                      docx={docx}
                      onUpdateResult={(updated, newMsg) => {
                        persistCurrentResult(updated);
                        if (newMsg) setMsg({ text: newMsg, err: false });
                      }}
                      onOpenResumeUpload={() => {
                        setEditingResume(true);
                        document.getElementById("resumeCard")?.scrollIntoView({ behavior: "smooth", block: "start" });
                      }}
                    />
                  )}

                  {tab === "outreach" && (
                    <OutreachTab
                      result={result}
                      onUpdateResult={(updated) => persistCurrentResult(updated)}
                    />
                  )}
                </>
              )}
            </div>
          </div>

          <footer>
            JobFit gives AI suggestions. Read every rewrite before you use it, and keep only what you can speak to in an interview.
          </footer>
        </div>
      </main>
    </>
  );
};
