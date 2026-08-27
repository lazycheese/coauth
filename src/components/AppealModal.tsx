import { useCoAuth } from "../store/coauthStore";
import { Dialog } from "./Dialog";

export function AppealModal() {
  const appeal = useCoAuth((s) => s.appealDraft);
  const setAppealDraft = useCoAuth((s) => s.setAppealDraft);
  if (!appeal) return null;
  return (
    <Dialog title="Draft appeal letter" testId="appeal-overlay" className="appeal-modal" onClose={() => setAppealDraft(null)}>
      <>
        <div className="cmp-head">
          <div>
            <h2>Draft appeal letter</h2>
            <p className="muted">Drafted from the record and the payer policy. Requires clinician review and signature.</p>
          </div>
          <button className="btn" style={{ width: "auto" }} onClick={() => setAppealDraft(null)}>Close</button>
        </div>
        <pre className="appeal-text" data-testid="appeal-text">{appeal}</pre>
      </>
    </Dialog>
  );
}
