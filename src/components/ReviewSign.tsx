import { useEffect, useRef, useState } from "react";
import { useCoAuth } from "../store/coauthStore";
import { humanActions } from "../app/actions";
import { useSession } from "../lib/useSession";

export function ReviewSign() {
  const validation = useCoAuth((s) => s.validation);
  const approvalToken = useCoAuth((s) => s.approvalToken);
  const auditLog = useCoAuth((s) => s.auditLog);
  const submitResult = useCoAuth((s) => s.submitResult);
  const signatureVoided = useCoAuth((s) => s.signatureVoided);
  const sign = useCoAuth((s) => s.sign);
  const logActivity = useCoAuth((s) => s.logActivity);
  const provenance = useCoAuth((s) => s.provenance);
  const session = useSession();
  const [attested, setAttested] = useState(false);
  const [clinicianId, setClinicianId] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
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

  // A judgment field holding text an agent wrote is not the clinician's
  // judgment, whatever the validator makes of it. fill_field refuses these
  // outright; this is the second lock, so a value that reaches the field by
  // some other route still cannot be signed over until the clinician adopts it.
  const agentWritten = (validation?.results ?? []).filter(
    (r) => r.requiresHumanJudgment && provenance[r.fieldId]?.by === "agent"
  );

  const authed = session.status === "authenticated";
  const canSign =
    authed &&
    missing === 0 &&
    judgmentPending.length === 0 &&
    agentWritten.length === 0 &&
    unresolvedCritical.length === 0 &&
    attested &&
    !approvalToken &&
    !signing;

  const onSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthBusy(true);
    setAuthError(null);
    try {
      setAuthError(await session.signIn(clinicianId, passphrase));
      setPassphrase("");
    } finally {
      setAuthBusy(false);
    }
  };

  const onSign = async (e?: React.MouseEvent) => {
    // A signature is an act, not a state transition. A synthetic click is not
    // the clinician signing, whatever the form happens to contain.
    if (e && !e.nativeEvent.isTrusted) {
      logActivity("agent", "sign", "REFUSED - a script cannot sign for the clinician");
      return;
    }
    setSigning(true);
    try {
      const token = await sign("I attest this prior authorization is clinically accurate.");
      if (token) logActivity("human", "sign", `Signed by ${token.signer} (NPI ${token.npi}), server-verified`);
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

      {agentWritten.length > 0 && (
        <div className="banner banner-warn" data-testid="agent-written-block">
          <strong>Agent-written text in a clinician field.</strong> {agentWritten.map((r) => r.label).join("; ")}. Read
          it, edit it if needed, and adopt it as your own before signing.
        </div>
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
          {authed ? (
            <div className="signer-identity" data-testid="signer-identity">
              <span>
                Signing as <strong>{session.clinician?.name}</strong>, {session.clinician?.role}, NPI{" "}
                {session.clinician?.npi}
              </span>
              <button className="btn btn-quiet" data-testid="sign-out" onClick={() => void session.signOut()}>
                Sign out
              </button>
            </div>
          ) : (
            <form className="signin" data-testid="clinician-signin" onSubmit={onSignIn}>
              <p className="muted">
                Only an authenticated clinician can sign. The approval is minted for the signed-in identity, so an
                agent driving this page has no route to one. Demo credentials are in the repository README, not on
                this page: printing them here would hand them to any agent reading the form.
              </p>
              <label>
                <span>Clinician</span>
                <select data-testid="signin-clinician" value={clinicianId} onChange={(e) => setClinicianId(e.target.value)}>
                  <option value="">Select</option>
                  {session.directory.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.role})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Passphrase</span>
                <input
                  type="password"
                  data-testid="signin-passphrase"
                  autoComplete="current-password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                />
              </label>
              <button className="btn" data-testid="signin-submit" disabled={authBusy || !clinicianId || !passphrase}>
                {authBusy ? "Signing in" : "Sign in"}
              </button>
              {authError && (
                <p className="danger-text" data-testid="signin-error">
                  {authError}
                </p>
              )}
            </form>
          )}
          <label className="attest">
            <input
              type="checkbox"
              data-testid="attest-checkbox"
              checked={attested}
              disabled={!authed || missing > 0 || judgmentPending.length > 0 || agentWritten.length > 0 || unresolvedCritical.length > 0}
              // Same reasoning as the form fields: only a real click attests.
              onChange={(e) => {
                if (!e.nativeEvent.isTrusted) {
                  logActivity("agent", "attest", "REFUSED - a script cannot tick the clinician's attestation");
                  return;
                }
                setAttested(e.target.checked);
              }}
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
                {a.voided ? "voided: the submission changed after this signature" : "signature verified by the server"}
              </span>
              <span className="muted">{a.hash}{a.confirmationId ? ` · ${a.confirmationId}` : ""}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
