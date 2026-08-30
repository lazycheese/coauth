import { getDrug, type Patient, type PayerRules } from "../data/seed";
import type { RiskAssessment, Conflict } from "./risk";

/** A trial is only "tried and failed" when the record says it failed.
 * Anything still running is reported as ongoing, never as failure. */
// How a trial ended is read from the chart's structured `result`, never from
// the wording of the note.
//
// This used to be substring matching over the free-text outcome, which is
// negation-blind: "Excellent response, no adverse events" matched on "adverse"
// and was printed to a payer as "Tried and failed", and "Good response;
// contraindication ruled out" matched on "contraindicat". Asserting a treatment
// failure the record contradicts, in a letter a clinician signs, is a false
// claim to an insurer - so the inference is gone rather than improved.

interface TrialSplit {
  failed: Patient["medsTried"];
  ongoing: Patient["medsTried"];
  /** Responded, or outcome not recorded. Neither supports a failure claim. */
  responded: Patient["medsTried"];
}

function splitTrials(patient: Patient): TrialSplit {
  const failed: Patient["medsTried"] = [];
  const ongoing: Patient["medsTried"] = [];
  const responded: Patient["medsTried"] = [];
  for (const m of patient.medsTried) {
    if (m.result === "failed") failed.push(m);
    else if (m.result === "ongoing") ongoing.push(m);
    else responded.push(m);
  }
  return { failed, ongoing, responded };
}

const describe = (m: Patient["medsTried"][number]) =>
  `${m.name}, ${m.durationMonths} month(s), documented outcome: ${m.outcome}`;

/** The therapy actually on the submission, not a hardcoded drug. */
function requestedTherapy(rules: PayerRules | null, formFields: Record<string, unknown> = {}): string {
  const code = String(formFields["hcpcs_code"] ?? "").trim();
  // The drug is whatever the submission requests, resolved from the code.
  //
  // This used to take the NAME from rules.drug - a per-payer constant reading
  // "Humira (adalimumab)" on every payer file - and the CODE from the form. A
  // request for J1438 therefore produced a letter to the insurer that read
  // "Humira (adalimumab) (HCPCS J1438)": two different molecules, with
  // different dosing, different indications and different formulary handling,
  // named as one drug in a document the clinician signs.
  const drug = getDrug(code);
  if (drug) return `${drug.name} (HCPCS ${drug.hcpcs})`;
  if (code) return `the requested therapy (HCPCS ${code}, not recognised in the coverage file)`;
  return rules?.drug ?? "the requested therapy";
}

/** The diagnosis being submitted, which is not always the chart's first one. */
function submittedDiagnosis(patient: Patient, formFields: Record<string, unknown> = {}) {
  const code = String(formFields["diagnosis_code"] ?? "").trim().toUpperCase();
  if (!code) return patient.diagnoses[0];
  const match = patient.diagnoses.find((d) => d.code.toUpperCase() === code);
  // A code that is on the form but not in the chart is reported as what it is,
  // rather than silently replaced by the chart's first diagnosis - which had
  // the letter arguing necessity for a condition other than the one filed.
  return match ?? { code, label: "not recorded in the chart under this code" };
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
  const dx = submittedDiagnosis(patient, formFields);
  const { failed, ongoing, responded } = splitTrials(patient);
  const crp = patient.labs.find((l) => l.name === "CRP")?.value;

  const trialLines: string[] = [];
  if (failed.length) trialLines.push(`Tried and failed: ${failed.map(describe).join("; ")}.`);
  if (ongoing.length) trialLines.push(`Currently ongoing (no failure documented): ${ongoing.map(describe).join("; ")}.`);
  if (responded.length) trialLines.push(`Responded or outcome not recorded (does not support a failure claim): ${responded.map(describe).join("; ")}.`);
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
  const dx = submittedDiagnosis(patient, formFields);
  const { failed, ongoing, responded } = splitTrials(patient);

  const therapyLines: string[] = [];
  if (failed.length) therapyLines.push(`- Tried and failed: ${failed.map(describe).join("; ")}.`);
  if (ongoing.length) therapyLines.push(`- Ongoing, no failure documented: ${ongoing.map(describe).join("; ")}.`);
  if (responded.length) therapyLines.push(`- Responded or outcome not recorded, so not offered as a failure: ${responded.map(describe).join("; ")}.`);
  if (!therapyLines.length) therapyLines.push("- No prior conventional therapy documented.");

  const resolved = conflicts.filter((c) => overrides[c.id]);
  const outstanding = conflicts.filter((c) => !overrides[c.id]);

  const conflictLines: string[] = [];

  // The screening section states what the chart records, before it states what
  // the rules engine found.
  //
  // Those are not the same thing, and treating them as the same produced a
  // letter that read "No clinical conflicts were detected in the record" for a
  // QuantiFERON-positive patient. The TB rule needs a drug on the form before
  // it can fire, so on an incomplete submission it had simply not run - and the
  // letter reported that silence as a clean screen, under a preamble promising
  // the statements were drawn from the record.
  const tbLab = patient.labs.find((l) => /TB|QuantiFERON/i.test(l.name));
  if (tbLab) {
    conflictLines.push(
      `- TB screening on record: ${tbLab.name} ${tbLab.value} (${tbLab.date}).` +
        (/positive|reactive/i.test(tbLab.value)
          ? " A positive screen is a contraindication to TNF-inhibitor therapy until latent TB is treated, and must be addressed before this therapy begins."
          : "")
    );
  } else {
    conflictLines.push("- No TB screening result is recorded in the chart.");
  }
  const otherAbnormal = patient.labs.filter((l) => l.flag === "critical" && l !== tbLab);
  for (const l of otherAbnormal) {
    conflictLines.push(`- Flagged as critical on record: ${l.name} ${l.value} (${l.date}).`);
  }

  for (const c of resolved) {
    conflictLines.push(`- ${c.label}: clinician override on file - ${overrides[c.id]}`);
  }
  for (const c of outstanding) {
    conflictLines.push(`- ${c.label}: OUTSTANDING - not yet addressed by the clinician.`);
  }

  // Several rules key off the requested drug, so on a submission without one
  // they cannot have run. Saying so is the honest report; saying nothing was
  // found is not.
  const drugOnForm = String(formFields["hcpcs_code"] ?? "").trim();
  if (!drugOnForm) {
    conflictLines.push(
      "- Drug-specific contraindication checks have NOT been run: no drug is on the submission yet, so this section is incomplete."
    );
  } else if (!resolved.length && !outstanding.length) {
    conflictLines.push("- The automated checks found no further conflicts on this submission.");
  }

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
