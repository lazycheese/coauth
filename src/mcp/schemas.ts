// JSON Schemas for each WebMCP tool's input.

export const schemas = {
  load_patient_context: {
    type: "object",
    properties: { patientId: { type: "string", description: "Patient id, e.g. jane-doe" } },
    required: ["patientId"],
  },
  check_payer_rules: {
    type: "object",
    properties: {
      payer: { type: "string", description: "Payer id: uhc or aetna" },
      drug: { type: "string", description: "Requested drug name" },
    },
    required: ["payer"],
  },
  fill_field: {
    type: "object",
    properties: {
      fieldId: { type: "string" },
      value: { type: "string" },
    },
    required: ["fieldId", "value"],
  },
  attach_evidence: {
    type: "object",
    properties: { fieldId: { type: "string" }, docId: { type: "string" } },
    required: ["fieldId", "docId"],
  },
  validate_submission: { type: "object", properties: {} },
  get_workflow_guidance: { type: "object", properties: {} },
  assess_denial_risk: { type: "object", properties: {} },
  detect_conflicts: { type: "object", properties: {} },
  draft_appeal: { type: "object", properties: {} },
  draft_field: {
    type: "object",
    properties: { fieldId: { type: "string", description: "A clinician-judgment field id, e.g. medical_necessity" } },
    required: ["fieldId"],
  },
  flag_for_human: {
    type: "object",
    properties: { fieldId: { type: "string" }, reason: { type: "string" } },
    required: ["fieldId", "reason"],
  },
  submit: { type: "object", properties: {} },
} as const;
