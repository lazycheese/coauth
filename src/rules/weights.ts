// Weights for the denial-risk score, in one place, each with the reason it is
// the number it is.
//
// The score is a small additive rule model with weights chosen by hand. That is
// a legitimate thing to build and a dishonest thing to hide: a clinician being
// shown "79%" deserves to know what produced it, and an auditor deserves to see
// the weights without reading the scoring function. Keeping them here with
// their reasoning means the number can be argued with, which is the point.
//
// The ordering reflects how payers actually behave: something that makes a
// submission wrong outranks something that makes it incomplete, because an
// incomplete form comes back for more information while a wrong one is denied.

export interface Weighted {
  points: number;
  /** Why this weight, in terms a reviewer can disagree with. */
  because: string;
}

export const BASE: Weighted = {
  points: 12,
  because:
    "No submission is certain. Even a complete, correct request carries administrative risk from transcription, routing and payer discretion.",
};

export const COMPLETENESS = {
  /** Missing required fields: first one hurts, each additional one adds less. */
  missingFirst: 8,
  missingEach: 6,
  missingCap: 34,
  missingBecause:
    "A missing field usually returns the request for more information rather than a denial, so it is weighted below a substantive error and capped: twenty gaps is not meaningfully worse than six, it is the same unfinished form.",

  /** Present but malformed: a wrong code is worse than an absent one. */
  invalidFirst: 10,
  invalidEach: 8,
  invalidCap: 30,
  invalidBecause:
    "A malformed value is worse than a blank one. A blank field is visibly unfinished; a wrong ICD-10 or NPI looks complete and is adjudicated as written, so it can be denied on its face.",

  judgment: {
    points: 8,
    because:
      "An unresolved clinician-judgment item is not an error, it is unfinished work that only the clinician can do. It is weighted low because it is expected at this stage.",
  } as Weighted,
};

/** Per-conflict weights. Each id matches a rule in risk.ts. */
export const CONFLICT: Record<string, Weighted> = {
  "tb-contra": {
    points: 33,
    because:
      "The highest weight here. A biologic requested against a positive TB screen is a safety problem before it is a coverage problem, and payers deny it outright pending evidence of treatment.",
  },
  "drug-not-covered": {
    points: 30,
    because:
      "The authorisation names a therapy the payer file does not cover, so it cannot be approved as written no matter how complete the rest of the form is.",
  },
  "indication-mismatch": {
    points: 30,
    because:
      "A drug requested outside its covered indications is an off-label request. It is not necessarily wrong clinically, but it is denied by default without a documented rationale.",
  },
  "step-insufficient": {
    points: 26,
    because:
      "Unmet step therapy is the single most common reason these requests come back, but it is recoverable with a documented exception, so it sits below the outright blockers.",
  },
  "member-payer-mismatch": {
    points: 24,
    because:
      "A member ID that does not match the payer is rejected in intake, before any clinical review. Cheap to fix, fatal if missed.",
  },
  "unknown-drug": {
    points: 22,
    because:
      "An unrecognised HCPCS code cannot be priced or matched to a policy. Weighted below a known-but-uncovered drug because it is more often a typo than a wrong request.",
  },
  "dose-out-of-range": {
    points: 20,
    because:
      "A dose the payer cannot match to the label invites a denial or a downward adjustment, but is frequently resolved by a pharmacist rather than refused.",
  },
  "dose-frequency": {
    points: 28,
    because:
      "A schedule error changes total exposure as surely as an amount error, and is the more common mistake in practice: the number on the page looks right, so nothing draws the eye to it. Blocking rather than advisory, because the difference between a one-off induction dose and a weekly one is not something to infer from a form.",
  },
  "active-infection": {
    points: 40,
    because:
      "A boxed-warning contraindication, weighted with the positive TB screen. Starting a TNF inhibitor during an active serious infection is the failure mode the warning exists for, and the chart already records the fact, so there is no reason for this to be anything but blocking.",
  },
  "dose-implausible": {
    points: 30,
    because:
      "An order-of-magnitude dose error is weighted well above an out-of-range dose because the two fail differently. A dose the payer disputes is argued about; a thousand-fold error that nobody catches is dispensed. It blocks signature rather than adding risk, because the clinician confirming they meant it is the only thing that distinguishes the two.",
  },
  "tb-screen-stale": {
    points: 26,
    because:
      "A screening result older than the payer's window is not evidence about the patient now, and both payer policies name a window in writing. Weighted just below an active contraindication: the risk is unknown rather than known-bad, which is exactly why it has to be resolved before a biologic starts.",
  },
  "dose-unreadable": {
    points: 14,
    because:
      "A dose that cannot be parsed cannot be checked against the label at all. It is weighted below an out-of-range dose because the likeliest cause is formatting rather than a wrong dose, but it cannot be waved through: an unreadable dose is how a thousand-fold unit error reaches a payer unexamined.",
  },
  "tb-evidence-unusable": {
    points: 18,
    because:
      "Weighted the same as missing screening evidence, because that is what it is. A field holding \"not done, pending\" documents the absence of a screen, and treating any text as satisfaction of the requirement is how an unscreened patient reaches a biologic.",
  },
  "tb-evidence-missing": {
    points: 18,
    because:
      "The screening requirement is documentary rather than clinical when the chart is otherwise clean, so this is a paperwork gap rather than a contraindication.",
  },
  "specialist-missing": {
    points: 16,
    because:
      "Specialist attestation is required by some payers and trivially satisfied when the prescriber qualifies, so it is weighted as an omission rather than a barrier.",
  },
};

export const BANDS = {
  high: 55,
  moderate: 28,
  because:
    "Bands are presentational. High begins where a single outright blocker plus baseline risk lands, moderate where accumulated paperwork gaps start to matter.",
};

/** The score is a likelihood, so it never claims certainty in either direction. */
export const CLAMP = {
  min: 3,
  max: 95,
  because:
    "No submission is guaranteed to be approved or denied. Reporting 0% or 100% would assert a certainty this model cannot have.",
};

/** Everything above, flattened for the tool and the interface to explain. */
export function weightRationale(): { key: string; points: number; because: string }[] {
  return [
    { key: "baseline", points: BASE.points, because: BASE.because },
    { key: "missing fields", points: COMPLETENESS.missingEach, because: COMPLETENESS.missingBecause },
    { key: "malformed fields", points: COMPLETENESS.invalidEach, because: COMPLETENESS.invalidBecause },
    { key: "unresolved clinician judgment", points: COMPLETENESS.judgment.points, because: COMPLETENESS.judgment.because },
    ...Object.entries(CONFLICT).map(([key, w]) => ({ key, points: w.points, because: w.because })),
  ];
}
