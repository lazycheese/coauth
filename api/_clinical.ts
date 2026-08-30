// Server-side clinical gate.
//
// The rules engine runs in the browser so the clinician sees a conflict the
// moment it appears. That is a usability decision, not a control: anything that
// skips the page skips the check with it. So the same engine runs here, over
// the submitted form, and a submission that fails it is refused regardless of
// how it arrived.
//
// This module imports the identical rules the page uses. There is deliberately
// no server-only copy to drift from the client one.

import { getPatient, getPayerRules } from "../src/data/seed";
import { validate } from "../src/rules/validate";
import { detectConflicts } from "../src/rules/risk";

export interface ClinicalRefusal {
  code: string;
  message: string;
  hint: string;
  detail?: unknown;
}

/** Re-run the rules over a submission. Returns null when it may proceed. */
export function clinicalRefusal(
  payer: string,
  patientId: string,
  formFields: Record<string, unknown>,
  overrides: Record<string, string>
): ClinicalRefusal | null {
  const rules = getPayerRules(payer);
  if (!rules) {
    return {
      code: "invalid_payer",
      message: `Unknown payer "${payer}".`,
      hint: "Valid payers: uhc, aetna, cigna.",
    };
  }

  const patient = getPatient(patientId);
  if (!patient) {
    return {
      code: "unknown_patient",
      message: `No patient with id "${patientId}".`,
      hint: "A submission must name the chart it was prepared from, so the rules can be checked against it.",
    };
  }

  const summary = validate(formFields, rules);

  // Required fields the payer asks for. A submission missing them is incomplete
  // whatever the client believed.
  const missing = summary.results.filter((r) => !r.ok && !r.requiresHumanJudgment);
  if (missing.length) {
    return {
      code: "incomplete_submission",
      message: `${missing.length} required field(s) are missing or malformed.`,
      hint: "Complete and correct every required field before submitting.",
      detail: missing.map((r) => ({ fieldId: r.fieldId, label: r.label, reason: r.reason })),
    };
  }

  // Clinician-judgment fields. The server cannot see who typed a value, so it
  // checks only that they are resolved; the page is what keeps an agent from
  // writing them, and the signature is what binds a clinician to them.
  const judgment = summary.results.filter((r) => !r.ok && r.requiresHumanJudgment);
  if (judgment.length) {
    return {
      code: "judgment_pending",
      message: `${judgment.length} clinician-judgment field(s) are unresolved.`,
      hint: "These are the clinician's to complete; an agent may propose text but cannot resolve them.",
      detail: judgment.map((r) => ({ fieldId: r.fieldId, label: r.label })),
    };
  }

  // Critical clinical conflicts. An override is a documented clinical decision,
  // so a conflict carrying one is allowed through; one without is not.
  const conflicts = detectConflicts(formFields, patient, rules, overrides ?? {});
  const blocking = conflicts.filter((c) => c.severity === "critical" && !overrides?.[c.id]);
  if (blocking.length) {
    return {
      code: "critical_conflict",
      message: `${blocking.length} unresolved critical clinical conflict(s).`,
      hint: "Resolve each conflict with a documented rationale, or correct the submission.",
      detail: blocking.map((c) => ({ id: c.id, label: c.label, detail: c.detail })),
    };
  }

  return null;
}
