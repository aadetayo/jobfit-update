import React, { useRef, useState } from "react";
import { SAMPLE_RESUME } from "../data/example";
import { bufToB64, readDocx, readPdf, scrubContact, tidy } from "../services/parser";
import { DocxFile } from "../types";

interface ResumeCardProps {
  resume: string;
  editingResume: boolean;
  docx: DocxFile | null;
  docxSaved: boolean;
  onSaveResume: (text: string, docx: DocxFile | null) => void;
  onStartEditing: () => void;
  onCancelEditing: () => void;
}

export const ResumeCard: React.FC<ResumeCardProps> = ({
  resume,
  editingResume,
  docx,
  docxSaved,
  onSaveResume,
  onStartEditing,
  onCancelEditing
}) => {
  const [text, setText] = useState(resume);
  const [pendingDocx, setPendingDocx] = useState<DocxFile | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [dropLabel, setDropLabel] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ msg: string; warn: boolean } | null>(null);
  const [errMsg, setErrMsg] = useState("");
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Sync state if prop changes while not editing
  React.useEffect(() => {
    if (!editingResume) {
      setText(resume);
      setErrMsg("");
      setNotice(null);
    }
  }, [resume, editingResume]);

  const handleFile = async (f: File) => {
    const name = f.name || "file";
    const ext = (name.split(".").pop() || "").toLowerCase();

    if (f.size > 10 * 1024 * 1024) {
      setNotice({ msg: "That file is over 10 MB. Try a smaller PDF or paste the text.", warn: true });
      return;
    }
    if (ext === "doc") {
      setNotice({ msg: "Old .doc files can't be read here. Save it as .docx or PDF, or paste the text.", warn: true });
      return;
    }

    setPendingDocx(null);
    setIsBusy(true);
    setDropLabel(`Reading ${name}…`);

    try {
      let rawText = "";
      if (ext === "pdf" || f.type === "application/pdf") {
        rawText = await readPdf(await f.arrayBuffer());
      } else if (ext === "docx") {
        const buf = await f.arrayBuffer();
        rawText = await readDocx(buf.slice(0));
        setPendingDocx({ id: String(Date.now()), name, b64: bufToB64(buf) });
      } else if (["txt", "md"].includes(ext) || f.type.startsWith("text/")) {
        rawText = await f.text();
      } else {
        setNotice({ msg: "Use a PDF, Word (.docx), or .txt file.", warn: true });
        setIsBusy(false);
        setDropLabel(null);
        return;
      }

      rawText = tidy(rawText || "");
      if (rawText.replace(/\s/g, "").length < 100) {
        setNotice({ msg: "No text found. This may be a scanned image. Paste the text instead.", warn: true });
        setIsBusy(false);
        setDropLabel(null);
        return;
      }

      const { text: clean, removed } = scrubContact(rawText);
      const cleaned = tidy(clean);
      setText(cleaned);

      const keep =
        ext === "docx"
          ? " Your Word formatting will be kept when you download."
          : ext === "pdf"
          ? " Tip: upload the Word version (.docx) instead if you want downloads to keep your formatting."
          : "";

      setNotice({
        msg: `Read ${name}${
          removed ? ". Removed your email and phone number before anything is sent for analysis" : ""
        }. Check the text below, then save.${keep}`,
        warn: ext === "pdf"
      });

      if (textareaRef.current) {
        textareaRef.current.scrollTop = 0;
        textareaRef.current.focus();
      }
    } catch {
      setNotice({
        msg: "Couldn't read that file. Try another format, or paste the text instead.",
        warn: true
      });
    } finally {
      setIsBusy(false);
      setDropLabel(null);
    }
  };

  const handleSave = () => {
    const v = text.trim();
    if (v.length < 150) {
      setErrMsg("Your resume looks too short. Paste the full text.");
      return;
    }
    setErrMsg("");
    let finalDocx: DocxFile | null = null;
    if (pendingDocx) {
      finalDocx = pendingDocx;
    } else if (v === resume) {
      finalDocx = docx;
    }
    onSaveResume(v, finalDocx);
  };

  const isSaved = Boolean(resume.trim()) && !editingResume;
  const wordCount = resume.trim() ? resume.trim().split(/\s+/).length : 0;
  const firstLine = resume.trim().split("\n").find((l) => l.trim()) || "Resume";

  return (
    <section className="card" id="resumeCard" aria-labelledby="resumeH">
      <div className="card-head">
        <div className="step">
          <b className={isSaved ? "done" : ""}>{isSaved ? "✓" : "1"}</b>
          <h2 id="resumeH">Your resume</h2>
        </div>
      </div>

      {!editingResume ? (
        <div className="resume-saved">
          <div className="doc" />
          <div className="meta">
            <strong>{firstLine}</strong>
            <span className="tiny">
              {docx
                ? `Word file · ${wordCount} words · your formatting is kept in downloads`
                : `Saved · ${wordCount} words · used for every check`}
            </span>
            {docx && !docxSaved && (
              <span className="tiny">This browser couldn't store the Word file, so re-upload it after a reload.</span>
            )}
          </div>
          <button type="button" className="linkbtn" onClick={onStartEditing}>
            Replace
          </button>
        </div>
      ) : (
        <>
          <input
            type="file"
            ref={fileInputRef}
            hidden
            accept=".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
              e.target.value = "";
            }}
          />

          <div
            className={`drop ${isDragOver ? "over" : ""} ${isBusy ? "busy" : ""}`}
            tabIndex={0}
            role="button"
            aria-label="Upload your resume: PDF, Word, or text file"
            onClick={() => {
              if (!isBusy) fileInputRef.current?.click();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                if (!isBusy) fileInputRef.current?.click();
              }
            }}
            onDragEnter={(e) => {
              e.preventDefault();
              setIsDragOver(true);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragOver(true);
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              setIsDragOver(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragOver(false);
              const f = e.dataTransfer?.files?.[0];
              if (f) handleFile(f);
            }}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5" />
              <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
            </svg>
            <strong>
              {dropLabel || (
                <>
                  Drop your resume here or <span className="choose">choose a file</span>
                </>
              )}
            </strong>
            <span className="tiny">Word (.docx) keeps your formatting · PDF and .txt work too</span>
          </div>

          <div className="or">or paste the text</div>

          {notice && (
            <div className={`notice ${notice.warn ? "warn" : ""}`} role="status">
              {notice.msg}
            </div>
          )}

          <textarea
            id="resume"
            ref={textareaRef}
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste your resume text here."
          />

          <div className="row spread" style={{ marginTop: "10px" }}>
            <div className="row">
              <button type="button" className="btn primary" onClick={handleSave}>
                Save resume
              </button>
              {Boolean(resume.trim()) && (
                <button type="button" className="btn ghost" onClick={onCancelEditing}>
                  Cancel
                </button>
              )}
            </div>
            <button
              type="button"
              className="linkbtn"
              onClick={() => {
                setText(SAMPLE_RESUME);
                setPendingDocx(null);
                setNotice(null);
                setErrMsg("");
                textareaRef.current?.focus();
              }}
            >
              Use sample resume
            </button>
          </div>

          {errMsg && (
            <div className="msg err" role="status">
              {errMsg}
            </div>
          )}
        </>
      )}
    </section>
  );
};
