import { useState } from "react";
import { useCoAuth } from "../store/coauthStore";

function ConflictCard({ id, severity, label, detail, requiresHumanOverride }: {
  id: string; severity: string; label: string; detail: string; requiresHumanOverride: boolean;
}) {
  const overrides = useCoAuth((s) => s.overrides);
  const resolveConflict = useCoAuth((s) => s.resolveConflict);
  const logActivity = useCoAuth((s) => s.logActivity);
  const [text, setText] = useState("");
  const resolved = !!overrides[id];

  return (
    <div className={`conflict conflict-${severity} ${resolved ? "conflict-resolved" : ""}`} data-testid={`conflict-${id}`}>
      <div className="conflict-head">
        <span className={`sev-tag sev-tag-${severity}`}>{severity}</span>
        <strong>{label}</strong>
        {requiresHumanOverride && !resolved && <span className="chip chip-critical" data-testid={`override-required-${id}`}>clinician override required</span>}
        {resolved && <span className="chip chip-ok">overridden</span>}
      </div>
      <p className="conflict-detail">{detail}</p>

      {requiresHumanOverride && !resolved && (
        <div className="override-box">
          <textarea
            data-testid={`override-input-${id}`}
            rows={2}
            placeholder="Document clinical override rationale…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button
            className="btn btn-danger"
            data-testid={`override-btn-${id}`}
            disabled={text.trim().length < 8}
            onClick={() => {
              resolveConflict(id, text.trim());
              logActivity("human", "override", `${id}: ${text.trim().slice(0, 48)}`);
            }}
          >
            Record clinical override
          </button>
        </div>
      )}
      {resolved && <p className="override-note">Override: {overrides[id]}</p>}
    </div>
  );
}

export function ConflictAlerts() {
  const conflicts = useCoAuth((s) => s.conflicts);
  if (conflicts.length === 0) return null;
  return (
    <div className="conflicts" data-testid="conflict-alerts">
      <div className="conflicts-title">Agent flagged {conflicts.length} clinical {conflicts.length === 1 ? "issue" : "issues"}</div>
      {conflicts.map((c) => <ConflictCard key={c.id} {...c} />)}
    </div>
  );
}
