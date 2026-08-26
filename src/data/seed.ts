// Seeded demo data - authentic prior-authorization structure.
// Drug: Humira (adalimumab), HCPCS J0135. Two payers, two patients
// (one clean approval, one denial-risk scenario).

export type FieldType = "text" | "code" | "date" | "select" | "evidence" | "longtext";

export interface FieldDef {
  id: string;
  label: string;
  type: FieldType;
  source?: string;
  options?: string[];
  requiresHumanJudgment?: boolean;
  placeholder?: string;
}

export interface PayerRules {
  id: string;
  name: string;
  drug: string;
  /** Human-readable coverage policy shown to the clinician. */
  policy: string[];
  requiredFields: FieldDef[];
}

export interface EvidenceDoc {
  id: string;
  label: string;
  kind: string;
}

export interface Patient {
  id: string;
  name: string;
  dob: string;
  memberId: string;
  diagnoses: { code: string; label: string }[];
  medsTried: { name: string; klass: string; durationMonths: number; outcome: string }[];
  labs: { name: string; value: string; date: string; flag?: "normal" | "abnormal" | "critical" }[];
  /** Clinical facts the risk/conflict engine reasons over. */
  clinical: {
    tbScreen: "negative" | "positive";
    activeInfection: boolean;
    priorBiologics: number;
  };
}

export const DRUG = "Humira (adalimumab)";
export const HCPCS = "J0135";

export const patients: Record<string, Patient> = {
  "jane-doe": {
    id: "jane-doe",
    name: "Jane Doe",
    dob: "1979-04-12",
    memberId: "UHC-88213",
    diagnoses: [{ code: "M06.9", label: "Rheumatoid arthritis, unspecified" }],
    medsTried: [
      { name: "Methotrexate", klass: "csDMARD", durationMonths: 4, outcome: "Inadequate response" },
      { name: "Sulfasalazine", klass: "csDMARD", durationMonths: 2, outcome: "Discontinued - intolerance" },
    ],
    labs: [
      { name: "CRP", value: "18 mg/L", date: "2026-08-10", flag: "abnormal" },
      { name: "ESR", value: "42 mm/hr", date: "2026-08-10", flag: "abnormal" },
      { name: "RF", value: "Positive", date: "2026-07-02", flag: "abnormal" },
      { name: "TB (QuantiFERON)", value: "Negative", date: "2026-08-01", flag: "normal" },
    ],
    clinical: { tbScreen: "negative", activeInfection: false, priorBiologics: 0 },
  },
  "marcus-lee": {
    id: "marcus-lee",
    name: "Marcus Lee",
    dob: "1968-11-30",
    memberId: "AET-55190",
    diagnoses: [{ code: "L40.50", label: "Arthropathic psoriasis, unspecified" }],
    // Denial-risk scenario: only 1 short DMARD trial AND a positive TB screen.
    medsTried: [
      { name: "Methotrexate", klass: "csDMARD", durationMonths: 1, outcome: "Ongoing - <3 months" },
    ],
    labs: [
      { name: "CRP", value: "9 mg/L", date: "2026-08-12", flag: "abnormal" },
      { name: "TB (QuantiFERON)", value: "Positive", date: "2026-08-05", flag: "critical" },
    ],
    clinical: { tbScreen: "positive", activeInfection: false, priorBiologics: 0 },
  },
};

export const docs: EvidenceDoc[] = [
  { id: "doc-cbc", label: "CBC panel (2026-08-10)", kind: "lab" },
  { id: "doc-tb", label: "TB screening (QuantiFERON)", kind: "lab" },
  { id: "doc-notes", label: "Rheumatology consult note", kind: "note" },
  { id: "doc-mtx", label: "Methotrexate trial summary", kind: "note" },
  { id: "doc-imaging", label: "Hand X-ray report", kind: "imaging" },
];

const baseFields: FieldDef[] = [
  { id: "member_id", label: "Member ID", type: "text", source: "patient.memberId" },
  { id: "prescriber_npi", label: "Prescriber NPI", type: "text", placeholder: "10-digit NPI" },
  { id: "diagnosis_code", label: "Primary diagnosis (ICD-10)", type: "code", source: "patient.diagnoses[0].code" },
  { id: "hcpcs_code", label: "Requested drug (HCPCS)", type: "code" },
  { id: "dose", label: "Dose & SIG", type: "text" },
  { id: "quantity", label: "Quantity / days supply", type: "text" },
  { id: "step_therapy", label: "Step therapy - DMARDs tried & failed", type: "longtext", source: "patient.medsTried" },
  { id: "tb_screen", label: "TB screening result", type: "evidence", source: "patient.labs.TB" },
];

export const payers: Record<string, PayerRules> = {
  uhc: {
    id: "uhc",
    name: "UnitedHealthcare",
    drug: DRUG,
    policy: [
      "Documented trial & failure of ≥1 conventional DMARD (e.g. methotrexate) for ≥3 months.",
      "Negative TB screening within 12 months prior to initiating a biologic.",
      "Prescriber attestation of medical necessity.",
    ],
    requiredFields: [
      ...baseFields,
      { id: "step_exception_rationale", label: "Step-therapy exception rationale", type: "longtext", requiresHumanJudgment: true },
      { id: "medical_necessity", label: "Statement of medical necessity", type: "longtext", requiresHumanJudgment: true },
      { id: "attending_attestation", label: "Attending clinician attestation", type: "select", options: ["Attested", "Not attested"], requiresHumanJudgment: true },
    ],
  },
  aetna: {
    id: "aetna",
    name: "Aetna",
    drug: DRUG,
    policy: [
      "Trial & failure of ≥1 conventional DMARD for ≥3 months.",
      "Negative TB screening required prior to biologic therapy.",
      "Statement of medical necessity from prescriber.",
    ],
    requiredFields: [
      ...baseFields,
      { id: "medical_necessity", label: "Statement of medical necessity", type: "longtext", requiresHumanJudgment: true },
      { id: "attending_attestation", label: "Attending clinician attestation", type: "select", options: ["Attested", "Not attested"], requiresHumanJudgment: true },
    ],
  },
  cigna: {
    id: "cigna",
    name: "Cigna",
    drug: DRUG,
    policy: [
      "Trial & failure of ≥2 conventional DMARDs, or documented intolerance.",
      "Prescriber must be, or consult, a rheumatologist (specialty attestation).",
      "Negative TB screening within 6 months.",
      "Statement of medical necessity.",
    ],
    requiredFields: [
      ...baseFields,
      { id: "specialist_attestation", label: "Rheumatology specialist attestation", type: "select", options: ["Rheumatologist", "Consulted rheumatology", "Neither"], requiresHumanJudgment: true },
      { id: "medical_necessity", label: "Statement of medical necessity", type: "longtext", requiresHumanJudgment: true },
      { id: "attending_attestation", label: "Attending clinician attestation", type: "select", options: ["Attested", "Not attested"], requiresHumanJudgment: true },
    ],
  },
};

/** Resolve a field's `source` expression to the actual scalar value in the record,
 * so provenance can be *verified* (value matches chart) rather than just asserted.
 * Returns undefined for non-scalar sources (which cannot be exact-matched). */
export function resolveSourceValue(source: string | undefined, patient: Patient | null): string | undefined {
  if (!source || !patient) return undefined;
  switch (source) {
    case "patient.memberId":
      return patient.memberId;
    case "patient.diagnoses[0].code":
      return patient.diagnoses[0]?.code;
    default:
      return undefined; // e.g. patient.medsTried, patient.labs.* - no single scalar to match
  }
}

export function getPatient(id: string): Patient | undefined {
  return patients[id];
}

export function getPayerRules(payer: string): PayerRules | undefined {
  return payers[payer];
}
