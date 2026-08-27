import { getDrug, payerMemberPrefix, type Patient, type PayerRules } from "../data/seed";
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
  overrides: Record<string, string>;
}

const str = (v: unknown) => (v == null ? "" : String(v).trim());

/** Longest conventional-DMARD trial in the chart, in months. */
function chartDmardMonths(patient: Patient | null): number {
  if (!patient) return 0;
  return patient.medsTried
    .filter((m) => m.klass === "csDMARD")
    .reduce((mx, m) => Math.max(mx, m.durationMonths), 0);
}

function chartDmardCount(patient: Patient | null): number {
  return patient ? patient.medsTried.filter((m) => m.klass === "csDMARD").length : 0;
}

/** Longest duration the submitted step-therapy narrative documents, in months.
 *
 * Only counts a duration the text actually asserts. A narrative saying a trial
 * ran for "under 3 months" is stating that the requirement was not met, and
 * reading the 3 out of it would let the text satisfy the very criterion it
 * denies. Qualified durations are therefore ignored rather than counted. */
const UNMET_QUALIFIER = /(?:<|under|less\s+than|fewer\s+than|no\s+more\s+than|up\s+to|only|barely|nearly|almost|approx\.?|approximately|~)\s*$/i;

function narrativeDmardMonths(text: string): number {
  let max = 0;
  const consider = (match: RegExpMatchArray, months: number) => {
    const preceding = text.slice(0, match.index ?? 0);
    if (UNMET_QUALIFIER.test(preceding)) return;
    max = Math.max(max, months);
  };
  for (const m of text.matchAll(/(\d+)\s*(?:mo|month)/gi)) consider(m, Number(m[1]));
  for (const m of text.matchAll(/(\d+)\s*(?:yr|year)/gi)) consider(m, Number(m[1]) * 12);
  return max;
}

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
    const m = dose.match(/(\d+(?:\.\d+)?)\s*mg/i);
    if (!m) return null;
    const mg = Number(m[1]);
    const [lo, hi] = drug.doseMgRange;
    if (mg < lo || mg > hi) {
      return {
        id: "dose-out-of-range",
        severity: "high",
        label: "Dose is outside the labelled range",
        detail: `${mg} mg is outside the ${lo}-${hi} mg range for ${drug.name}. Payers routinely deny doses they cannot match to the label.`,
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

  // Biologic requires TB screening evidence on the submission.
  ({ formFields }) => {
    const drug = getDrug(str(formFields["hcpcs_code"]));
    if (!drug?.requiresTbScreen) return null;
    if (str(formFields["tb_screen"])) return null;
    return {
      id: "tb-evidence-missing",
      severity: "high",
      label: "No TB screening evidence attached",
      detail: `${drug.name} requires documented TB screening before initiation. Attach the screening result to the submission.`,
      requiresHumanOverride: false,
      points: CONFLICT["tb-evidence-missing"].points,
      weightRationale: CONFLICT["tb-evidence-missing"].because,
    };
  },

  // Step therapy, judged against the payer's numeric criteria using the chart
  // and whatever the submitted narrative documents.
  ({ formFields, patient, rules }) => {
    if (!rules) return null;
    const { minDmardMonths, minDmardCount } = rules.criteria;
    const months = Math.max(chartDmardMonths(patient), narrativeDmardMonths(str(formFields["step_therapy"])));
    const count = chartDmardCount(patient);
    const shortTrial = months < minDmardMonths;
    const tooFew = count < minDmardCount;
    if (!shortTrial && !tooFew) return null;
    const reasons: string[] = [];
    if (shortTrial) reasons.push(`longest documented trial is ${months} month(s) against a ${minDmardMonths}-month requirement`);
    if (tooFew) reasons.push(`${count} conventional DMARD(s) documented against a minimum of ${minDmardCount}`);
    return {
      id: "step-insufficient",
      severity: "high",
      label: "Step-therapy criteria not met",
      detail: `${rules.name} requires ${minDmardCount} conventional DMARD(s) tried for at least ${minDmardMonths} months: ${reasons.join("; ")}. Document a step-therapy exception rationale or extend the trial.`,
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
