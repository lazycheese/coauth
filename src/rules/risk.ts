import { getDrug, payerMemberPrefix, docs, type Patient, type PayerRules } from "../data/seed";
import { validate } from "./validate";
import { BASE, COMPLETENESS, CONFLICT, BANDS, CLAMP } from "./weights";

export interface RiskFactor {
  label: string;
  points: number;
  severity: "low" | "medium" | "high";
  /** Why this contributes what it does. */
  because: string;
}

export interface RiskAssessment {
  /** Heuristic denial likelihood (rule-based, not a trained model). */
  score: number;
  band: "low" | "moderate" | "high";
  factors: RiskFactor[];
}

export interface Conflict {
  id: string;
  severity: "high" | "critical";
  label: string;
  detail: string;
  /** Critical conflicts block signature until a clinician records an override. */
  requiresHumanOverride: boolean;
  /** Points added to the denial-risk score while unresolved. */
  points: number;
  /** Why the weight is what it is, so the score can be argued with. */
  weightRationale: string;
}

export interface SubmissionContext {
  formFields: Record<string, unknown>;
  patient: Patient | null;
  rules: PayerRules | null;
  /** Clinician overrides, keyed by conflict id.
   *
   * No rule reads this: a rule's job is to report what it finds, and whether a
   * finding has been overridden is a question for the caller. detectConflicts
   * returns every conflict, and callers filter on overrides - which is what
   * lets an overridden conflict still appear in the audit trail and the appeal
   * letter rather than vanishing. Kept on the context so a future rule can see
   * a related override without changing every signature. */
  overrides: Record<string, string>;
}

const str = (v: unknown) => (v == null ? "" : String(v).trim());

/** Trials that count towards step therapy.
 *
 * Step-therapy criteria are about drugs that were tried and did not work. A
 * drug the patient is still taking has not failed yet, and a drug that worked
 * has not failed at all - counting either of them as a failure told the
 * clinician a criterion was met when it was not. The chart states the outcome;
 * this reads it rather than inferring it. */
function failedDmardTrials(patient: Patient | null) {
  if (!patient) return [];
  return patient.medsTried.filter((m) => m.klass === "csDMARD" && m.result === "failed");
}

/** Longest failed conventional-DMARD trial in the chart, in months. */
function chartDmardMonths(patient: Patient | null): number {
  return failedDmardTrials(patient).reduce((mx, m) => Math.max(mx, m.durationMonths), 0);
}

function chartDmardCount(patient: Patient | null): number {
  return failedDmardTrials(patient).length;
}

// The step-therapy narrative is no longer parsed for durations, and this is
// deliberate.
//
// Reading a number out of free text could only ever loosen the criterion: any
// figure found there was max'd against the chart, so text could satisfy a
// requirement the record did not support. "Patient has had symptoms for 24
// months. No DMARD has been started." cleared a three-month DMARD requirement.
// Guarding the immediately preceding words only caught the phrasings that were
// tested; the next phrasing walked straight through.
//
// The chart is what documents a trial. Where a trial genuinely happened
// elsewhere and is not in the chart, the route is the step-therapy exception
// rationale - a clinician-judgment field, signed for - rather than a sentence a
// tool can write.

/** Every rule reads the submission, so what the agent fills changes the outcome. */
type Rule = (c: SubmissionContext) => Conflict | null;

const RULES: Rule[] = [
  // The submitted drug must be one this payer file actually authorises.
  ({ formFields, rules }) => {
    const hcpcs = str(formFields["hcpcs_code"]).toUpperCase();
    if (!hcpcs || !rules) return null;
    const covered = rules.coveredDrugs ?? [];
    if (!covered.length || covered.includes(hcpcs)) return null;
    const drug = getDrug(hcpcs);
    return {
      id: "drug-not-covered",
      severity: "critical",
      label: "Requested drug is not covered by this payer file",
      detail: `${drug?.name ?? hcpcs} is not on the ${rules.name} authorisation for this request, which covers ${covered.join(", ")}. Submitting it as-is authorises the wrong therapy. Correct the code, switch to the right payer file, or record a clinician override.`,
      requiresHumanOverride: true,
      points: CONFLICT["drug-not-covered"].points,
      weightRationale: CONFLICT["drug-not-covered"].because,
    };
  },

  // Requested drug must be indicated for the diagnosis actually submitted.
  ({ formFields }) => {
    const hcpcs = str(formFields["hcpcs_code"]);
    const dx = str(formFields["diagnosis_code"]).toUpperCase();
    if (!hcpcs || !dx) return null;
    const drug = getDrug(hcpcs);
    if (!drug) {
      return {
        id: "unknown-drug",
        severity: "high",
        label: "Requested HCPCS code is not a recognised drug",
        detail: `HCPCS ${hcpcs} does not match a drug in the coverage file. Confirm the code before submitting.`,
        requiresHumanOverride: false,
        points: CONFLICT["unknown-drug"].points,
      weightRationale: CONFLICT["unknown-drug"].because,
      };
    }
    if (!drug.indications.some((p) => dx.startsWith(p))) {
      return {
        id: "indication-mismatch",
        severity: "critical",
        label: "Requested drug is not indicated for the submitted diagnosis",
        detail: `${drug.name} is covered for ${drug.indicationLabel}. The submitted diagnosis ${dx} is outside that set. Correct the diagnosis or the drug, or record a clinician override for off-label use.`,
        requiresHumanOverride: true,
        points: CONFLICT["indication-mismatch"].points,
      weightRationale: CONFLICT["indication-mismatch"].because,
      };
    }
    return null;
  },

  // Dose must be plausible for the requested drug.
  ({ formFields }) => {
    const drug = getDrug(str(formFields["hcpcs_code"]));
    const dose = str(formFields["dose"]);
    if (!drug || !dose) return null;
    // Match the unit as well as the number. Anchoring on "mg" alone let "40
    // mcg" - a thousand-fold underdose - pass without comment, because the
    // pattern simply did not match and the rule returned null.
    const m = dose.match(/(\d+(?:\.\d+)?)\s*(mcg|micrograms?|ug|mg|milligrams?|g|grams?)\b/i);
    if (!m) {
      return {
        id: "dose-unreadable",
        // Blocking. The weight note already argued this - "an unreadable dose is
        // how a thousand-fold unit error reaches a payer unexamined" - while the
        // severity waved it through. The reasoning was right; the severity was
        // not.
        severity: "critical",
        label: "Dose is not in a readable form",
        detail: `"${dose}" does not state a dose and a unit that can be checked against the label for ${drug.name}. Write it as a number and a unit, for example "40 mg every other week".`,
        requiresHumanOverride: true,
        points: CONFLICT["dose-unreadable"].points,
        weightRationale: CONFLICT["dose-unreadable"].because,
      };
    }
    const unit = m[2].toLowerCase();
    const toMg = unit.startsWith("mc") || unit === "ug" ? 0.001 : unit.startsWith("g") ? 1000 : 1;
    const mg = Number(m[1]) * toMg;
    const [lo, hi] = drug.doseMgRange;

    // An order-of-magnitude miss is a different kind of problem from a dose the
    // payer will argue about. "40 mcg" for a 40 mg drug is a thousand-fold
    // underdose, and a submission carrying one should not be signable at all
    // without the clinician saying, in writing, that they meant it.
    // 3x, not 10x. A tenfold band left everything from 1.1x to 10x - up to
    // 1600 mg of adalimumab, forty pens - as a non-blocking advisory.
    if (mg > 0 && (mg * 3 < lo || mg > hi * 3)) {
      const factor = mg * 3 < lo ? Math.round(lo / mg) : Math.round(mg / hi);
      return {
        id: "dose-implausible",
        severity: "critical",
        label: "Dose is off by an order of magnitude",
        detail: `${m[1]} ${unit} is ${mg} mg, roughly ${factor}x outside the ${lo}-${hi} mg labelled range for ${drug.name} (${drug.doseNote}). This is the shape of a unit or decimal error rather than a dosing decision. Correct it, or record an override stating the dose is intended.`,
        requiresHumanOverride: true,
        points: CONFLICT["dose-implausible"].points,
        weightRationale: CONFLICT["dose-implausible"].because,
      };
    }
    if (mg < lo || mg > hi) {
      return {
        id: "dose-out-of-range",
        severity: "high",
        label: "Dose is outside the labelled range",
        detail: `${m[1]} ${unit} is ${mg} mg, outside the ${lo}-${hi} mg labelled range for ${drug.name} (${drug.doseNote}). Payers routinely deny doses they cannot match to the label.`,
        requiresHumanOverride: false,
        points: CONFLICT["dose-out-of-range"].points,
      weightRationale: CONFLICT["dose-out-of-range"].because,
      };
    }
    return null;
  },

  // The submitted member id should belong to the payer being billed.
  ({ formFields, rules }) => {
    const member = str(formFields["member_id"]).toUpperCase();
    const prefix = rules ? payerMemberPrefix[rules.id] : undefined;
    if (!member || !prefix || !rules) return null;
    if (!member.startsWith(prefix)) {
      return {
        id: "member-payer-mismatch",
        severity: "high",
        label: "Member ID does not match the selected payer",
        detail: `${rules.name} member IDs begin with ${prefix}. The submitted ID "${member}" does not, which will be rejected before clinical review.`,
        requiresHumanOverride: false,
        points: CONFLICT["member-payer-mismatch"].points,
      weightRationale: CONFLICT["member-payer-mismatch"].because,
      };
    }
    return null;
  },

  // Active serious infection with a biologic request.
  //
  // Every TNF inhibitor carries a boxed warning against starting therapy during
  // an active infection. The chart records the fact, the MCP schema publishes
  // it, and until now nothing read it: the field was modelled and never
  // evaluated, which is worse than not modelling it, because the data was there
  // to be checked and the check was absent.
  ({ formFields, patient }) => {
    const drug = getDrug(str(formFields["hcpcs_code"]));
    if (!patient || !drug) return null;
    if (!patient.clinical.activeInfection) return null;
    return {
      id: "active-infection",
      severity: "critical",
      label: "Active infection with a biologic request",
      detail: `The chart records an active infection. ${drug.name} carries a boxed warning against initiation during an active serious infection. Treat the infection first, or record an override documenting why therapy should begin now.`,
      requiresHumanOverride: true,
      points: CONFLICT["active-infection"].points,
      weightRationale: CONFLICT["active-infection"].because,
    };
  },

  // Biologic with a positive TB screen on the chart.
  ({ formFields, patient }) => {
    const drug = getDrug(str(formFields["hcpcs_code"]));
    if (!patient || !drug?.requiresTbScreen) return null;
    if (patient.clinical.tbScreen !== "positive") return null;
    return {
      id: "tb-contra",
      severity: "critical",
      label: "Positive TB screen with biologic request",
      detail: `QuantiFERON positive. ${drug.name} is contraindicated in untreated latent TB. Requires clinician override documenting latent-TB treatment or risk acceptance.`,
      requiresHumanOverride: true,
      points: CONFLICT["tb-contra"].points,
      weightRationale: CONFLICT["tb-contra"].because,
    };
  },

  // Biologic requires TB screening evidence on the submission, and the evidence
  // has to be a screening result rather than any non-empty string. Accepting
  // whatever was typed meant "not done, pending" satisfied the requirement.
  ({ formFields, patient }) => {
    const drug = getDrug(str(formFields["hcpcs_code"]));
    if (!drug?.requiresTbScreen) return null;
    const value = str(formFields["tb_screen"]);
    if (!value) {
      return {
        id: "tb-evidence-missing",
        severity: "high",
        label: "No TB screening evidence attached",
        detail: `${drug.name} requires documented TB screening before initiation. Attach the screening result to the submission.`,
        requiresHumanOverride: false,
        points: CONFLICT["tb-evidence-missing"].points,
        weightRationale: CONFLICT["tb-evidence-missing"].because,
      };
    }
    // Either the attached screening document, or text that states a result the
    // chart's own lab agrees with.
    const lab = patient?.labs.find((l) => /TB|QuantiFERON/i.test(l.name));
    const attached = value === "doc-tb";
    const statesResult = /\b(negative|positive|non-?reactive|reactive)\b/i.test(value);
    const agreesWithChart =
      !lab || !statesResult
        ? false
        : /negative|non-?reactive/i.test(value) === /negative/i.test(lab.value);
    if (!attached && !(statesResult && agreesWithChart)) {
      return {
        id: "tb-evidence-unusable",
        // Blocking, not advisory. A field reading "not done, pending" documents
        // the absence of a screen, and a biologic started without one is the
        // outcome the screening requirement exists to prevent.
        severity: "critical",
        label: "TB screening evidence does not state a result",
        detail: lab
          ? `"${value}" is not a screening result that can be checked. The chart records TB (${lab.name}) as ${lab.value} on ${lab.date}. Attach the screening document, or record the result the chart supports.`
          : `"${value}" is not a screening result. Attach the TB screening document.`,
        requiresHumanOverride: true,
        points: CONFLICT["tb-evidence-unusable"].points,
        weightRationale: CONFLICT["tb-evidence-unusable"].because,
      };
    }
    return null;
  },

  // The screening has to be recent enough for the payer's written policy.
  //
  // Both policies name a window and nothing evaluated one, so a screen from
  // three years ago satisfied the requirement. A stale screen is not evidence
  // that the patient is clear now.
  ({ formFields, patient, rules }) => {
    const drug = getDrug(str(formFields["hcpcs_code"]));
    if (!drug?.requiresTbScreen || !rules || !patient) return null;
    if (!str(formFields["tb_screen"])) return null;
    const maxAge = rules.criteria.tbScreenMaxAgeMonths;
    if (!maxAge) return null;

    // Date the evidence that was actually submitted, not only the chart lab.
    // Attaching the screening document is the normal path, and keying off the
    // chart alone meant that path skipped the window entirely.
    const attachedId = str(formFields["tb_screen"]);
    const attached = docs.find((d) => d.id === attachedId);
    const lab = patient.labs.find((l) => /TB|QuantiFERON/i.test(l.name));
    const dated = attached?.date ?? lab?.date;
    const source = attached?.date ? `the attached ${attached.label}` : "the screen on record";

    if (!dated) {
      return {
        id: "tb-screen-undated",
        severity: "critical",
        label: "TB screening evidence carries no date",
        detail: `${rules.name} requires TB screening within ${maxAge} months of starting a biologic, and nothing submitted here says when the screening was done. Attach a dated result, or record an override.`,
        requiresHumanOverride: true,
        points: CONFLICT["tb-screen-stale"].points,
        weightRationale: CONFLICT["tb-screen-stale"].because,
      };
    }
    const when = Date.parse(dated);
    if (Number.isNaN(when)) return null;

    const ageMonths = (Date.now() - when) / (1000 * 60 * 60 * 24 * 30.44);
    if (ageMonths <= maxAge) return null;
    return {
      id: "tb-screen-stale",
      severity: "critical",
      label: "TB screening is older than the payer allows",
      detail: `${rules.name} requires TB screening within ${maxAge} months of starting a biologic. ${source} is dated ${dated}, about ${Math.round(ageMonths)} months ago. Repeat the screening, or record an override documenting why the existing result still stands.`,
      requiresHumanOverride: true,
      points: CONFLICT["tb-screen-stale"].points,
      weightRationale: CONFLICT["tb-screen-stale"].because,
    };
  },

  // Dosing frequency, which nothing looked at.
  //
  // Adalimumab errors in practice are overwhelmingly frequency errors - weekly
  // where the label says every other week - and the amount can be perfectly
  // correct while the schedule doubles the exposure. Reading only the first
  // number and unit meant "160 mg every week", an induction dose given
  // chronically, passed without comment.
  ({ formFields }) => {
    const drug = getDrug(str(formFields["hcpcs_code"]));
    const dose = str(formFields["dose"]);
    if (!drug || !dose) return null;
    const lower = dose.toLowerCase();
    // "every other week" must not read as "every week", so the alternate
    // schedule is excluded before the weekly one is looked for.
    const alternate = /every\s+other\s+week|eow|q2w|biweekly|fortnight/.test(lower);
    const weekly = !alternate && /(every\s+week|weekly|once\s+a\s+week|q1w|qw)/.test(lower);
    if (!weekly) return null;
    const m = lower.match(/(\d+(?:\.\d+)?)\s*(?:mg|milligrams?)/);
    const mg = m ? Number(m[1]) : null;
    // Weekly adalimumab is labelled for some indications, so a weekly schedule
    // is a question rather than an error - except at an induction amount, which
    // is given once and is not a schedule anyone intends to repeat.
    if (drug.hcpcs !== "J0135" || mg === null || mg < 80) return null;
    return {
      id: "dose-frequency",
      severity: "critical",
      label: "Induction dose written as an ongoing weekly schedule",
      detail: `"${dose}" gives ${mg} mg every week. For ${drug.name}, ${mg} mg is an induction dose given once, not a maintenance schedule (${drug.doseNote}). Confirm the intended frequency, or record an override.`,
      requiresHumanOverride: true,
      points: CONFLICT["dose-frequency"].points,
      weightRationale: CONFLICT["dose-frequency"].because,
    };
  },

  // Step therapy, judged against the payer's numeric criteria using the chart
  // and whatever the submitted narrative documents.
  ({ formFields, patient, rules }) => {
    if (!rules) return null;
    const { minDmardMonths, minDmardCount } = rules.criteria;
    const months = chartDmardMonths(patient);
    const count = chartDmardCount(patient);
    const shortTrial = months < minDmardMonths;
    const tooFew = count < minDmardCount;
    if (!shortTrial && !tooFew) return null;
    const reasons: string[] = [];
    if (shortTrial) reasons.push(`longest failed trial in the chart is ${months} month(s) against a ${minDmardMonths}-month requirement`);
    if (tooFew) reasons.push(`${count} failed conventional DMARD(s) in the chart against a minimum of ${minDmardCount}`);
    return {
      id: "step-insufficient",
      severity: "high",
      label: "Step-therapy criteria not met",
      detail: `${rules.name} requires ${minDmardCount} conventional DMARD(s) tried and failed for at least ${minDmardMonths} months: ${reasons.join("; ")}. Only trials the chart records as failed are counted; ongoing therapy and therapy that responded do not qualify. Document a step-therapy exception rationale, or extend the trial.`,
      requiresHumanOverride: false,
      points: CONFLICT["step-insufficient"].points,
      weightRationale: CONFLICT["step-insufficient"].because,
    };
  },

  // Payers that require a specialist need that attestation to actually say so.
  ({ formFields, rules }) => {
    if (!rules?.criteria.requiresSpecialist) return null;
    const v = str(formFields["specialist_attestation"]);
    if (!v || v === "Neither") {
      return {
        id: "specialist-missing",
        severity: "high",
        label: "Specialist involvement not attested",
        detail: `${rules.name} requires the prescriber to be, or to have consulted, a rheumatologist. Record the specialist attestation.`,
        requiresHumanOverride: false,
        points: CONFLICT["specialist-missing"].points,
      weightRationale: CONFLICT["specialist-missing"].because,
      };
    }
    return null;
  },
];

/** Clinical and coverage conflicts found in the current submission. */
export function detectConflicts(
  formFields: Record<string, unknown>,
  patient: Patient | null,
  rules: PayerRules | null = null,
  overrides: Record<string, string> = {}
): Conflict[] {
  const ctx: SubmissionContext = { formFields, patient, rules, overrides };
  const out: Conflict[] = [];
  for (const rule of RULES) {
    const c = rule(ctx);
    if (c) out.push(c);
  }
  return out;
}

/** Heuristic denial-risk score. Rule-based and additive, not a trained model:
 * every contribution is an explicit, explainable factor. */
export function assessRisk(
  formFields: Record<string, unknown>,
  patient: Patient | null,
  rules: PayerRules | null,
  overrides: Record<string, string> = {}
): RiskAssessment {
  const factors: RiskFactor[] = [];
  let score = BASE.points;

  const v = validate(formFields, rules);
  const missing = Math.max(0, v.failCount - v.invalidCount);
  if (missing > 0) {
    const c = COMPLETENESS;
    const pts = Math.min(c.missingCap, c.missingFirst + missing * c.missingEach);
    score += pts;
    factors.push({ label: `${missing} required field(s) incomplete`, points: pts, severity: "high", because: c.missingBecause });
  }
  if (v.invalidCount > 0) {
    const c = COMPLETENESS;
    const pts = Math.min(c.invalidCap, c.invalidFirst + v.invalidCount * c.invalidEach);
    score += pts;
    factors.push({ label: `${v.invalidCount} field(s) have format/content errors`, points: pts, severity: "high", because: c.invalidBecause });
  }
  if (v.judgmentCount > 0) {
    score += COMPLETENESS.judgment.points;
    factors.push({
      label: `${v.judgmentCount} clinician judgment item(s) unresolved`,
      points: COMPLETENESS.judgment.points,
      severity: "medium",
      because: COMPLETENESS.judgment.because,
    });
  }

  // Unresolved conflicts found in the submission itself carry their own weight.
  for (const c of detectConflicts(formFields, patient, rules, overrides)) {
    if (overrides[c.id]) continue;
    score += c.points;
    factors.push({
      label: c.label,
      points: c.points,
      severity: c.severity === "critical" ? "high" : "medium",
      because: c.weightRationale,
    });
  }

  score = Math.max(CLAMP.min, Math.min(CLAMP.max, score));
  const band = score >= BANDS.high ? "high" : score >= BANDS.moderate ? "moderate" : "low";
  return { score, band, factors };
}
