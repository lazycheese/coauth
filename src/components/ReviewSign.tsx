import { useEffect, useRef, useState } from "react";
import { useCoAuth } from "../store/coauthStore";
import { humanActions } from "../app/actions";
import { useSession } from "../lib/useSession";
import { isHumanGesture } from "../lib/humanGesture";

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
  // Asked for again at the moment of signing, and never held anywhere else. A
  // session cookie travels with every request the page makes, including one a
  // script makes, so a session alone cannot be what authorises a signature.
  const [signingPassphrase, setSigningPassphrase] = useState("");
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
    signingPassphrase.length > 0 &&
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
    if (e && !isHumanGesture(e)) {
      logActivity("agent", "sign", "REFUSED - a script cannot sign for the clinician");
      return;
    }
    setSigning(true);
    try {
      const token = await sign("I attest this prior authorization is clinically accurate.", signingPassphrase);
      // Cleared either way: it is not kept across an attempt.
      setSigningPassphrase("");
      if (token) logActivity("human", "sign", `Signed by ${token.signer} (NPI ${token.npi}), server-verified`);
    } finally {
      setSigning(false);
    }
  };
  const submitted = submitResult?.status === "submitted";

  const onSubmit = async (e?: React.MouseEvent) => {
    // Filing is the irreversible step. The clinician signed, but signing and
    // filing are separate decisions and the second one is theirs as well.
    if (e && !isHumanGesture(e)) {
      logActivity("agent", "submit", "REFUSED - a script cannot file the submission");
      return;
    }
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
          {submitResult.x12 && (
            <details className="x12" data-testid="x12-278">
              <summary>View X12 278 (payer EDI)</summary>
              <p className="x12-note">
                The transaction a payer actually receives. A prior authorization is exchanged as an X12 278
                Health Care Services Review - the HIPAA-mandated authorization transaction - not as JSON. Every
                value the agent filled and the clinician signed maps to a segment below.
              </p>
              <pre>{submitResult.x12}</pre>
            </details>
          )}
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
                <span>Clinician ID</span>
                <input
                  type="text"
                  data-testid="signin-clinician"
                  autoComplete="username"
                  placeholder="e.g. a-alvarez"
                  value={clinicianId}
                  onChange={(e) => setClinicianId(e.target.value)}
                />
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
                if (!isHumanGesture(e)) {
                  logActivity("agent", "attest", "REFUSED - a script cannot tick the clinician's attestation");
                  return;
                }
                setAttested(e.target.checked);
              }}
            />
            <span>I attest this prior authorization is clinically accurate.</span>
          </label>
          {authed && (
            <label className="signer-field">
              <span>Confirm your passphrase to sign</span>
              <input
                type="password"
                data-testid="sign-passphrase"
                autoComplete="current-password"
                value={signingPassphrase}
                disabled={!authed || missing > 0 || judgmentPending.length > 0 || agentWritten.length > 0 || unresolvedCritical.length > 0}
                onChange={(e) => setSigningPassphrase(e.target.value)}
              />
              <small className="muted">
                Asked for every signature. Being signed in is not enough on its own, because a script running in
                this page carries the same session.
              </small>
            </label>
          )}
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
