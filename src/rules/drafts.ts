import type { Patient, PayerRules } from "../data/seed";
import type { RiskAssessment, Conflict } from "./risk";

/** A trial is only "tried and failed" when the record says it failed.
 * Anything still running is reported as ongoing, never as failure. */
const FAILED_RE = /inadequate|intoleran|discontinued|fail|adverse|contraindicat/i;
const ONGOING_RE = /ongoing|continuing|current|partial/i;

interface TrialSplit {
  failed: Patient["medsTried"];
  ongoing: Patient["medsTried"];
  unclear: Patient["medsTried"];
}

function splitTrials(patient: Patient): TrialSplit {
  const failed: Patient["medsTried"] = [];
  const ongoing: Patient["medsTried"] = [];
  const unclear: Patient["medsTried"] = [];
  for (const m of patient.medsTried) {
    if (FAILED_RE.test(m.outcome)) failed.push(m);
    else if (ONGOING_RE.test(m.outcome)) ongoing.push(m);
    else unclear.push(m);
  }
  return { failed, ongoing, unclear };
}

const describe = (m: Patient["medsTried"][number]) =>
  `${m.name}, ${m.durationMonths} month(s), documented outcome: ${m.outcome}`;

/** The therapy actually on the submission, not a hardcoded drug. */
function requestedTherapy(rules: PayerRules | null, formFields: Record<string, unknown> = {}): string {
  const code = String(formFields["hcpcs_code"] ?? "").trim();
  const drug = rules?.drug ?? "the requested therapy";
  return code ? `${drug} (HCPCS ${code})` : drug;
}

const NEEDS_CLINICIAN = "[Clinician: complete this assessment before signing.]";

/** Draft language for clinician-judgment fields.
 * States only what the record supports and leaves every clinical conclusion to
 * the clinician. The agent proposes; the clinician edits and accepts. */
export function draftFor(
  fieldId: string,
  patient: Patient | null,
  rules: PayerRules | null = null,
  formFields: Record<string, unknown> = {}
): string | null {
  if (!patient) return null;
  const dx = patient.diagnoses[0];
  const { failed, ongoing, unclear } = splitTrials(patient);
  const crp = patient.labs.find((l) => l.name === "CRP")?.value;

  const trialLines: string[] = [];
  if (failed.length) trialLines.push(`Tried and failed: ${failed.map(describe).join("; ")}.`);
  if (ongoing.length) trialLines.push(`Currently ongoing (no failure documented): ${ongoing.map(describe).join("; ")}.`);
  if (unclear.length) trialLines.push(`Outcome not documented: ${unclear.map(describe).join("; ")}.`);
  if (!trialLines.length) trialLines.push("No prior conventional therapy is documented in the record.");

  switch (fieldId) {
    case "medical_necessity":
      return [
        `Record summary for ${patient.name}: ${dx.label} (${dx.code})${crp ? `, CRP ${crp}` : ""}.`,
        `Requested therapy: ${requestedTherapy(rules, formFields)}.`,
        ...trialLines,
        `Assessment of medical necessity: ${NEEDS_CLINICIAN}`,
      ].join(" ");

    case "step_exception_rationale":
      return [
        `Documented conventional therapy history: ${trialLines.join(" ")}`,
        ongoing.length && !failed.length
          ? "Note: the record shows ongoing therapy without a documented failure, which may not meet the payer's step-therapy criterion."
          : "",
        `Rationale for a step-therapy exception: ${NEEDS_CLINICIAN}`,
      ]
        .filter(Boolean)
        .join(" ");

    default:
      return null;
  }
}

/** Draft appeal letter. Every clinical claim is derived from the record; any
 * unresolved conflict is listed as outstanding rather than asserted as handled. */
export function draftAppeal(
  patient: Patient | null,
  rules: PayerRules | null,
  risk: RiskAssessment | null,
  conflicts: Conflict[] = [],
  overrides: Record<string, string> = {},
  formFields: Record<string, unknown> = {}
): string | null {
  if (!patient || !rules) return null;
  const dx = patient.diagnoses[0];
  const { failed, ongoing, unclear } = splitTrials(patient);

  const therapyLines: string[] = [];
  if (failed.length) therapyLines.push(`- Tried and failed: ${failed.map(describe).join("; ")}.`);
  if (ongoing.length) therapyLines.push(`- Ongoing, no failure documented: ${ongoing.map(describe).join("; ")}.`);
  if (unclear.length) therapyLines.push(`- Outcome not documented: ${unclear.map(describe).join("; ")}.`);
  if (!therapyLines.length) therapyLines.push("- No prior conventional therapy documented.");

  const resolved = conflicts.filter((c) => overrides[c.id]);
  const outstanding = conflicts.filter((c) => !overrides[c.id]);

  const conflictLines: string[] = [];
  for (const c of resolved) {
    conflictLines.push(`- ${c.label}: clinician override on file - ${overrides[c.id]}`);
  }
  for (const c of outstanding) {
    conflictLines.push(`- ${c.label}: OUTSTANDING - not yet addressed by the clinician.`);
  }
  if (!conflictLines.length) conflictLines.push("- No clinical conflicts were detected in the record.");

  const drivers = (risk?.factors ?? []).map((f) => `- ${f.label}`).join("\n") || "- Administrative or documentation gaps.";

  return `To the ${rules.name} Pharmacy & Therapeutics Appeals Committee,

RE: Appeal of prior-authorization denial - ${patient.name}, Member ${patient.memberId}
Requested therapy: ${requestedTherapy(rules, formFields)} for ${dx.label} (${dx.code})

This letter requests reconsideration of the above prior authorization. The
statements below are drawn directly from the patient record.

Payer coverage criteria:
${rules.policy.map((p) => `- ${p}`).join("\n")}

Conventional therapy history on record:
${therapyLines.join("\n")}

Contraindication screening:
${conflictLines.join("\n")}

Factors contributing to denial risk on this submission:
${drivers}

${NEEDS_CLINICIAN} The clinician must confirm each statement above, add the
clinical argument for medical necessity, and sign before this letter is sent.

DRAFT - not for submission without clinician review and signature.`;
}
