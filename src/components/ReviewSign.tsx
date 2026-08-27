import { useEffect, useRef, useState } from "react";
import { useCoAuth } from "../store/coauthStore";
import { humanActions } from "../app/actions";

export function ReviewSign() {
  const validation = useCoAuth((s) => s.validation);
  const approvalToken = useCoAuth((s) => s.approvalToken);
  const auditLog = useCoAuth((s) => s.auditLog);
  const submitResult = useCoAuth((s) => s.submitResult);
  const signatureVoided = useCoAuth((s) => s.signatureVoided);
  const sign = useCoAuth((s) => s.sign);
  const logActivity = useCoAuth((s) => s.logActivity);
  const [attested, setAttested] = useState(false);
  const [signer, setSigner] = useState("");
  const [signing, setSigning] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // State updates are batched, so two clicks in the same tick both read the old
  // value. The guard has to be synchronous to catch a double click at all.
  const inFlight = useRef(false);

  // The attestation is a statement about the values that were on screen when it
  // was made. If those change, it has to be given again rather than carried
  // over, so the box clears itself along with the signature.
  useEffect(() => {
    if (signatureVoided) setAttested(false);
  }, [signatureVoided]);

  const conflicts = useCoAuth((s) => s.conflicts);
  const overrides = useCoAuth((s) => s.overrides);
  const unresolvedCritical = conflicts.filter((c) => c.requiresHumanOverride && !overrides[c.id]);

  const judgmentPending = validation?.results.filter((r) => !r.ok && r.requiresHumanJudgment) ?? [];
  const missing = validation?.failCount ?? 0;
  // An attestation with no identifiable signer is not an approval.
  const signerOk = signer.trim().length >= 3;
  const canSign =
    missing === 0 && judgmentPending.length === 0 && unresolvedCritical.length === 0 && attested && signerOk && !approvalToken && !signing;

  const onSign = async () => {
    setSigning(true);
    try {
      const token = await sign("I attest this prior authorization is clinically accurate.", signer.trim());
      logActivity("human", "sign", `Signed by ${signer.trim()} (${token.serverVerified ? "server-verified" : "local only"})`);
    } finally {
      setSigning(false);
    }
  };
  const submitted = submitResult?.status === "submitted";

  const onSubmit = async () => {
    // An approval is good for one submission, so a second click would be
    // refused by the server and its refusal would overwrite the confirmation
    // already on screen. Guard the click rather than explain the wreckage.
    if (inFlight.current || submitted) return;
    inFlight.current = true;
    setSubmitting(true);
    try {
      // The tool logs the call itself, attributed to the human initiator.
      await humanActions.submit();
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  };

  return (
    <div className="review-sign" data-testid="review-sign">
      <h3>Review &amp; Sign</h3>

      {signatureVoided && (
        <div className="banner banner-warn" data-testid="signature-voided">
          <strong>The signature no longer applies.</strong> This submission changed after it was signed, so the
          attestation has been cleared. Review the changes and sign again.
        </div>
      )}

      {submitResult?.status === "blocked" && (
        <div className="banner banner-blocked" data-testid="blocked-banner">
          <strong>Submission blocked.</strong>{" "}
          {submitResult.reason ?? "The submission was not accepted."}
        </div>
      )}
      {submitResult?.status === "submitted" && (
        <div className="success-card" data-testid="submitted-banner">
          <div className="success-check" aria-hidden="true"></div>
          <div className="success-title">Submitted to payer</div>
          <div className="success-id">{submitResult.confirmationId}</div>
          <div className="success-sub">Clinician-signed · conflict-checked · audit-logged</div>
        </div>
      )}

      {missing > 0 && <p className="muted">{missing} required field(s) still missing.</p>}
      {unresolvedCritical.length > 0 && (
        <p className="muted danger-text" data-testid="critical-block-note">
          {unresolvedCritical.length} critical conflict(s) need a clinical override before signing.
        </p>
      )}

      {judgmentPending.length > 0 && (
        <div className="judgment-list">
          <p className="muted">Needs your clinical judgment:</p>
          <ul>
            {judgmentPending.map((r) => (
              <li key={r.fieldId}>{r.label}</li>
            ))}
          </ul>
        </div>
      )}

      {!approvalToken ? (
        <>
          <label className="signer-field">
            <span>Signing clinician</span>
            <input
              type="text"
              data-testid="signer-input"
              placeholder="Name and credentials"
              value={signer}
              disabled={missing > 0 || judgmentPending.length > 0 || unresolvedCritical.length > 0}
              onChange={(e) => setSigner(e.target.value)}
            />
          </label>
          <label className="attest">
            <input
              type="checkbox"
              data-testid="attest-checkbox"
              checked={attested}
              disabled={missing > 0 || judgmentPending.length > 0 || unresolvedCritical.length > 0}
              onChange={(e) => setAttested(e.target.checked)}
            />
            <span>I attest this prior authorization is clinically accurate.</span>
          </label>
          <button className="btn btn-primary" data-testid="approve-sign" disabled={!canSign} onClick={onSign}>
            {signing ? "Signing" : "Approve & Sign"}
          </button>
        </>
      ) : (
        <button
          className="btn btn-primary"
          data-testid="submit-btn"
          onClick={onSubmit}
          disabled={submitting || submitted}
        >
          {submitting ? "Submitting" : submitted ? "Submitted" : "Submit prior authorization"}
        </button>
      )}

      {auditLog.length > 0 && (
        <div className="audit" data-testid="audit-log">
          <p className="muted">Audit trail</p>
          {auditLog.map((a, i) => (
            <div className={`audit-row${a.voided ? " audit-voided" : ""}`} key={i}>
              <span>
                {a.signer ? `${a.signer}: ` : ""}
                {a.attestation}
              </span>
              <span className={`audit-verify verify-${a.voided ? "voided" : a.verifiedBy}`}>
                {a.voided
                  ? "voided: the submission changed after this signature"
                  : a.verifiedBy === "server"
                  ? "signature verified by the server"
                  : "local signature only, not server-verified"}
              </span>
              <span className="muted">{a.hash}{a.confirmationId ? ` · ${a.confirmationId}` : ""}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
