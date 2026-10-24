import React, { useState } from "react";

interface ShareModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ShareModal: React.FC<ShareModalProps> = ({ isOpen, onClose }) => {
  const [copyStatus, setCopyStatus] = useState("Paste it into a text, Slack, or LinkedIn.");

  if (!isOpen) return null;

  const shareUrl = window.location.origin + window.location.pathname;
  const shareText = `Try JobFit, a free tool I built to help you tailor your resume for any job. Upload your resume, paste a job posting, and it shows how well you fit, which gaps to address, and rewrites your bullets in the job's language. You can download the tailored resume in your own format. It never makes up experience.\n\n${shareUrl}`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareText);
      setCopyStatus("Copied. Paste it anywhere.");
    } catch {
      setCopyStatus("Press Ctrl/⌘+C to copy the message.");
    }
  };

  return (
    <div className="share-pop gutter">
      <div className="inner">
        <div className="share-card" role="dialog" aria-labelledby="shareH">
          <div className="row spread">
            <strong id="shareH">Share JobFit with a friend</strong>
            <button type="button" className="x" aria-label="Close" onClick={onClose}>
              ×
            </button>
          </div>
          <textarea rows={4} readOnly value={shareText} />
          <div className="row">
            <button type="button" className="btn primary" onClick={handleCopy}>
              Copy message
            </button>
            <span className="tiny" role="status">
              {copyStatus}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
