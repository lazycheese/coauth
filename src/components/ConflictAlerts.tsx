import { useState } from "react";
import { useCoAuth } from "../store/coauthStore";

function ConflictCard({ id, severity, label, detail, requiresHumanOverride }: {
  id: string; severity: string; label: string; detail: string; requiresHumanOverride: boolean;
}) {
  const overrides = useCoAuth((s) => s.overrides);
  const resolveConflict = useCoAuth((s) => s.resolveConflict);
  const logActivity = useCoAuth((s) => s.logActivity);
  const [text, setText] = useState("");
  // Tracks whether this rationale was ever written by something other than a
  // person, so a script cannot type the text and then have a real click commit
  // it. Cleared only by starting again.
  const [typedByScript, setTypedByScript] = useState(false);
  const [refused, setRefused] = useState(false);
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
            // The override rationale is the highest-consequence free text in
            // the product: it is what lets a biologic be filed over a positive
            // TB screen. Every other human control here checks isTrusted; this
            // one did not, so a script could author the clinical justification,
            // have it logged as the clinician's, and leave the clinician a box
            // to tick. Typed by a script, it is recorded as the script's.
            onChange={(e) => {
              setText(e.target.value);
              setTypedByScript((prev) => prev || !e.nativeEvent.isTrusted);
            }}
          />
          <button
            className="btn btn-danger"
            data-testid={`override-btn-${id}`}
            disabled={text.trim().length < 8}
            onClick={(e) => {
              if (!e.nativeEvent.isTrusted || typedByScript) {
                logActivity("agent", "override", `REFUSED - ${id}: an override must be written and recorded by the clinician`);
                setRefused(true);
                return;
              }
              setRefused(false);
              resolveConflict(id, text.trim());
              logActivity("human", "override", `${id}: ${text.trim().slice(0, 48)}`);
            }}
          >
            Record clinical override
          </button>
        </div>
      )}
      {refused && (
        <p className="override-note danger-text" data-testid={`override-refused-${id}`}>
          That rationale was entered by a script rather than typed. An override is a clinical decision, so it has to
          be the clinician's own words: clear the box and write it.
        </p>
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
