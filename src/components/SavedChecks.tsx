import React, { useState } from "react";
import { computeFit } from "../services/parser";
import { SavedCheck } from "../types";

interface SavedChecksProps {
  history: SavedCheck[];
  currentId: string | null;
  onSelectCheck: (check: SavedCheck) => void;
  onDeleteCheck: (id: string) => void;
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

function band(s: number): "hi" | "mid" | "lo" {
  return s >= 70 ? "hi" : s >= 55 ? "mid" : "lo";
}

export const SavedChecks: React.FC<SavedChecksProps> = ({
  history,
  currentId,
  onSelectCheck,
  onDeleteCheck
}) => {
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  return (
    <section className="card" aria-labelledby="histH">
      <div className="card-head">
        <div className="step">
          <h2 id="histH">Saved checks</h2>
        </div>
        <span className="tiny" id="histCount">
          {history.length ? `${history.length} saved` : ""}
        </span>
      </div>

      <ul className="hist" id="hist">
        {!history.length ? (
          <li>
            <p className="tiny">
              Each fit check you run is saved here so you can compare roles. Nothing yet: the report on the right is an
              example.
            </p>
          </li>
        ) : (
          history.map((h) => {
            if (pendingDelete === h.id) {
              return (
                <li key={h.id}>
                  <div className="confirm-del">
                    <span>Delete this check?</span>
                    <button
                      type="button"
                      className="btn danger"
                      onClick={() => {
                        onDeleteCheck(h.id);
                        setPendingDelete(null);
                      }}
                    >
                      Delete
                    </button>
                    <button type="button" className="btn ghost" onClick={() => setPendingDelete(null)}>
                      Keep
                    </button>
                  </div>
                </li>
              );
            }

            const sc = computeFit(h.result).score;
            const isActive = currentId === h.id;

            return (
              <li key={h.id}>
                <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", alignItems: "center" }}>
                  <button
                    type="button"
                    className={`hist-item ${isActive ? "active" : ""}`}
                    style={{ gridTemplateColumns: "44px minmax(0, 1fr)" }}
                    onClick={() => onSelectCheck(h)}
                  >
                    <span className={`pill ${band(sc)}`}>{sc}</span>
                    <span className="t">
                      <strong>{h.result.role || "Untitled role"}</strong>
                      <span>{fmtDate(h.at)}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="x"
                    aria-label={`Delete ${h.result.role || "check"}`}
                    onClick={() => setPendingDelete(h.id)}
                  >
                    ×
                  </button>
                </div>
              </li>
            );
          })
        )}
      </ul>
    </section>
  );
};
