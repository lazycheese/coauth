import { useCoAuth } from "../store/coauthStore";

export function AppealModal() {
  const appeal = useCoAuth((s) => s.appealDraft);
  const setAppealDraft = useCoAuth((s) => s.setAppealDraft);
  if (!appeal) return null;
  return (
    <div className="cmp-overlay" data-testid="appeal-overlay" onClick={() => setAppealDraft(null)}>
      <div className="appeal-modal" onClick={(e) => e.stopPropagation()}>
        <div className="cmp-head">
          <div>
            <h2>Draft appeal letter</h2>
            <p className="muted">Agent-drafted · grounded in the record &amp; payer policy · requires clinician review and signature.</p>
          </div>
          <button className="btn" style={{ width: "auto" }} onClick={() => setAppealDraft(null)}>Close</button>
        </div>
        <pre className="appeal-text" data-testid="appeal-text">{appeal}</pre>
      </div>
    </div>
  );
}
