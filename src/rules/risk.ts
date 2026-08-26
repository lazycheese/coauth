import type { Patient, PayerRules } from "../data/seed";
import { validate } from "./validate";

export interface RiskFactor {
  label: string;
  points: number;
  severity: "low" | "medium" | "high";
}

export interface RiskAssessment {
  score: number; // 0..95 denial probability
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
}

/** Longest continuous conventional-DMARD trial, in months. */
function maxDmardMonths(patient: Patient): number {
  return patient.medsTried
    .filter((m) => m.klass === "csDMARD")
    .reduce((mx, m) => Math.max(mx, m.durationMonths), 0);
}

/** Denial-probability model over the current submission. */
export function assessRisk(
  formFields: Record<string, unknown>,
  patient: Patient | null,
  rules: PayerRules | null,
  overrides: Record<string, string> = {}
): RiskAssessment {
  const factors: RiskFactor[] = [];
  let score = 12; // base administrative risk

  const v = validate(formFields, rules);
  if (v.failCount > 0) {
    const pts = Math.min(34, 8 + v.failCount * 6);
    score += pts;
    factors.push({ label: `${v.failCount} required field(s) incomplete`, points: pts, severity: "high" });
  }
  if (v.invalidCount > 0) {
    const pts = Math.min(30, 10 + v.invalidCount * 8);
    score += pts;
    factors.push({ label: `${v.invalidCount} field(s) have format/content errors`, points: pts, severity: "high" });
  }
  if (v.judgmentCount > 0) {
    score += 8;
    factors.push({ label: `${v.judgmentCount} clinician judgment item(s) unresolved`, points: 8, severity: "medium" });
  }

  if (patient) {
    if (maxDmardMonths(patient) < 3 && !overrides["step-insufficient"]) {
      score += 26;
      factors.push({ label: "Step therapy < 3 months (policy requires ≥3)", points: 26, severity: "high" });
    }
    if (patient.clinical.tbScreen === "positive" && !overrides["tb-contra"]) {
      score += 33;
      factors.push({ label: "Positive TB screen - biologic contraindication", points: 33, severity: "high" });
    }
  }

  score = Math.max(3, Math.min(95, score));
  const band = score >= 55 ? "high" : score >= 28 ? "moderate" : "low";
  return { score, band, factors };
}

/** Clinical contradictions the agent surfaces for the clinician. */
export function detectConflicts(
  formFields: Record<string, unknown>,
  patient: Patient | null
): Conflict[] {
  const out: Conflict[] = [];
  if (!patient) return out;

  if (patient.clinical.tbScreen === "positive") {
    out.push({
      id: "tb-contra",
      severity: "critical",
      label: "Positive TB screen with biologic request",
      detail:
        "QuantiFERON positive. Adalimumab is contraindicated in untreated latent TB. Requires clinician override documenting latent-TB treatment or risk acceptance.",
      requiresHumanOverride: true,
    });
  }
  if (maxDmardMonths(patient) < 3) {
    out.push({
      id: "step-insufficient",
      severity: "high",
      label: "Step-therapy criteria not met",
      detail:
        "Longest conventional DMARD trial is under 3 months. Payer requires ≥3 months of trial & failure, or a documented step-therapy exception rationale.",
      requiresHumanOverride: false,
    });
  }
  return out;
}
