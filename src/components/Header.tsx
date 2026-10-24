import React from "react";

interface HeaderProps {
  isReturning: boolean;
  onOpenShare: () => void;
}

export const Header: React.FC<HeaderProps> = ({ isReturning, onOpenShare }) => {
  return (
    <header className="band gutter">
      <div className="inner">
        <div className="nav">
          <div className="logo-wrap">
            <div className="logo">
              <svg viewBox="0 0 32 32" aria-hidden="true">
                <rect x="2.5" y="2.5" width="27" height="27" rx="5" fill="none" stroke="currentColor" strokeWidth="2.5" />
                <rect x="9" y="9" width="14" height="14" rx="2" fill="var(--mark)" />
              </svg>
              <span>JobFit</span>
            </div>
            {isReturning && <span className="tag">Know your fit before you hit apply.</span>}
          </div>
          <div className="nav-r">
            <div className="trust">
              <span>Free to use</span>
              <span>Resume saved only in your browser</span>
              <span>Never invents experience</span>
            </div>
            <button type="button" className="share" onClick={onOpenShare}>
              Share JobFit
            </button>
          </div>
        </div>

        {!isReturning && (
          <>
            <div className="hero">
              <h1>
                Know your <em>fit</em> before you hit apply.
              </h1>
              <p>
                Upload your resume and paste a job. Get a fit score, the gaps to address, rewritten bullets, and a tailored resume in your own format.
              </p>
            </div>
            <ol className="how">
              <li>
                <b>Add your resume</b>Upload Word to keep your formatting.
              </li>
              <li>
                <b>Paste the job</b>The whole page is fine, menus and all.
              </li>
              <li>
                <b>Get callback-ready</b>Score, gaps, new bullets, and a note.
              </li>
            </ol>
          </>
        )}
      </div>
    </header>
  );
};
