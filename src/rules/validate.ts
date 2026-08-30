import type { FieldDef, PayerRules } from "../data/seed";

export interface FieldResult {
  fieldId: string;
  label: string;
  ok: boolean;
  reason?: string;
  /** Filled but fails a format/content rule (distinct from simply missing). */
  invalid: boolean;
  requiresHumanJudgment: boolean;
}

/** Per-field content validators. Return an error message, or null if valid. */
const FORMAT: Record<string, (v: string) => string | null> = {
  prescriber_npi: (v) => (/^\d{10}$/.test(v.trim()) ? null : "NPI must be exactly 10 digits"),
  // ICD-10-CM: a letter, two alphanumerics, then up to four alphanumerics after
  // an optional dot. The third character and every character after the dot can
  // be a letter - M1A.00 (chronic gout), C4A.0 (Merkel cell carcinoma) and the
  // 7th-character extensions like S72.001A are all valid, and a digits-only
  // pattern rejected every one of them.
  diagnosis_code: (v) =>
    /^[A-TV-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,4})?$/i.test(v.trim()) ? null : "Expected ICD-10-CM code (e.g. M06.9, M1A.00, S72.001A)",
  hcpcs_code: (v) => (/^J\d{4}$/i.test(v.trim()) ? null : "Expected HCPCS J-code (e.g. J0135)"),
};

export interface ValidationSummary {
  results: FieldResult[];
  failCount: number;
  judgmentCount: number;
  invalidCount: number;
  passCount: number;
  /** True only when every non-judgment field passes. Gate precondition. */
  clearForSignature: boolean;
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}

/** Pure rules engine. Shared by client tools and the Edge validate function. */
export function validate(
  formFields: Record<string, unknown>,
  rules: PayerRules | null
): ValidationSummary {
  const fields: FieldDef[] = rules?.requiredFields ?? [];
  const results: FieldResult[] = fields.map((f) => {
    const raw = formFields[f.id];
    const filled = !isEmpty(raw);
    const judgment = !!f.requiresHumanJudgment;
    // "Not attested" counts as unresolved for the attestation field.
    const attestationBad = f.id === "attending_attestation" && raw === "Not attested";
    const specialistBad = f.id === "specialist_attestation" && raw === "Neither";
    // Content/format check for filled fields.
    const formatError = filled && FORMAT[f.id] ? FORMAT[f.id](String(raw)) : null;
    const ok = filled && !attestationBad && !specialistBad && !formatError;
    const invalid = filled && (!!formatError || attestationBad || specialistBad);
    return {
      fieldId: f.id,
      label: f.label,
      ok,
      invalid,
      requiresHumanJudgment: judgment,
      reason: ok
        ? undefined
        : formatError
        ? formatError
        : judgment
        ? "Needs clinician judgment"
        : "Missing required value",
    };
  });

  const failCount = results.filter((r) => !r.ok && !r.requiresHumanJudgment).length;
  const judgmentCount = results.filter((r) => !r.ok && r.requiresHumanJudgment).length;
  const invalidCount = results.filter((r) => r.invalid && !r.requiresHumanJudgment).length;
  const passCount = results.filter((r) => r.ok).length;

  return {
    results,
    failCount,
    judgmentCount,
    invalidCount,
    passCount,
    clearForSignature: failCount === 0,
  };
}
