import type { Patient, PayerRules } from "../data/seed";
import type { RiskAssessment } from "./risk";

/** Grounded draft language for clinician-judgment fields.
 * The agent proposes; the clinician edits and accepts. Never auto-filled. */
export function draftFor(fieldId: string, patient: Patient | null): string | null {
  if (!patient) return null;
  const dx = patient.diagnoses[0];
  const dmards = patient.medsTried.map((m) => `${m.name} (${m.durationMonths} mo - ${m.outcome.toLowerCase()})`).join("; ");
  const crp = patient.labs.find((l) => l.name === "CRP")?.value;

  switch (fieldId) {
    case "medical_necessity":
      return `${patient.name} has ${dx.label} (${dx.code})${crp ? `, CRP ${crp}` : ""}, with inadequate disease control on conventional therapy (${dmards}). Adalimumab (HCPCS J0135) is medically necessary to achieve disease control and prevent progression. [Clinician: review & edit before signing.]`;
    case "step_exception_rationale":
      return `Documented trial and failure of conventional DMARD therapy: ${dmards}. Continued conventional therapy is not clinically appropriate; a step-therapy exception is requested per payer policy. [Clinician: confirm accuracy before signing.]`;
    default:
      return null;
  }
}

/** A grounded appeal letter for a high-risk or denied prior authorization.
 * Cites the specific denial drivers and the record - the work that makes the
 * documented 82% appeal-overturn rate reachable without hours of manual writing. */
export function draftAppeal(
  patient: Patient | null,
  rules: PayerRules | null,
  risk: RiskAssessment | null
): string | null {
  if (!patient || !rules) return null;
  const dx = patient.diagnoses[0];
  const dmards = patient.medsTried.map((m) => `${m.name} for ${m.durationMonths} month(s) (${m.outcome.toLowerCase()})`).join("; ");
  const drivers = (risk?.factors ?? []).map((f) => `• ${f.label}`).join("\n") || "• Administrative/documentation gaps";
  const today = "the date of this letter";

  return `To the ${rules.name} Pharmacy & Therapeutics Appeals Committee,

RE: Appeal of prior-authorization denial - ${patient.name}, Member ${patient.memberId}
Requested therapy: Adalimumab (HCPCS J0135) for ${dx.label} (${dx.code})

We are appealing the denial of the above prior authorization. The clinical record supports medical necessity and, we believe, meets ${rules.name} coverage policy:

Coverage criteria addressed:
${rules.policy.map((p) => `• ${p}`).join("\n")}

Clinical basis:
• Diagnosis: ${dx.label} (${dx.code}), active disease.
• Conventional therapy tried & failed: ${dmards}.
• Contraindication screening reviewed and addressed by the attending clinician.

The original denial appears driven by:
${drivers}

Each item above has been documented in the attached record. We respectfully request reconsideration and approval. Please contact the prescribing clinician with any questions.

Submitted for clinician review and signature as of ${today}.`;
}
