import { patients, payers, docs, drugs } from "../data/seed";

// Input schemas for the WebMCP tools.
//
// These are the only contract an agent has. Every property carries a
// description, and every bounded property carries an enum, so a model can make
// a correct call the first time instead of guessing at an opaque string. The
// enums are derived from the seed data rather than written out by hand, so they
// cannot drift out of date as patients, payers, drugs or documents change.

const patientIds = Object.keys(patients);
const payerIds = Object.keys(payers);
const docIds = docs.map((d) => d.id);
const hcpcsCodes = Object.keys(drugs);

/** Every field id any payer can ask for, with its label, for the description. */
const fieldEntries = Array.from(
  new Map(
    Object.values(payers)
      .flatMap((p) => p.requiredFields)
      .map((f) => [f.id, f])
  ).values()
);
const fieldIds = fieldEntries.map((f) => f.id);
const judgmentFieldIds = fieldEntries.filter((f) => f.requiresHumanJudgment).map((f) => f.id);
/** What fill_field will accept. The clinician-judgment fields are absent from
 * the enum rather than merely discouraged in the description: a rule stated in
 * prose is a rule an agent can decline to follow, and this one is the product's
 * central promise. The tool refuses them as well, so the schema is a hint and
 * the executor is the control. */
const fillableFieldIds = fieldEntries.filter((f) => !f.requiresHumanJudgment).map((f) => f.id);
/** Fields that actually take a document. */
const evidenceFieldIds = fieldEntries.filter((f) => f.type === "evidence" && !f.requiresHumanJudgment).map((f) => f.id);
const fillableFieldList = fieldEntries
  .filter((f) => !f.requiresHumanJudgment)
  .map((f) => `${f.id} (${f.label})`)
  .join("; ");
const draftableFieldIds = ["medical_necessity", "step_exception_rationale"];

const fieldList = fieldEntries.map((f) => `${f.id} (${f.label})`).join("; ");
const docList = docs.map((d) => `${d.id} (${d.label})`).join("; ");

export const schemas = {
  get_workflow_guidance: { type: "object", properties: {}, additionalProperties: false },

  get_submission_state: { type: "object", properties: {}, additionalProperties: false },

  load_patient_context: {
    type: "object",
    properties: {
      patientId: {
        type: "string",
        enum: patientIds,
        description: `Identifier of the patient whose record to load. Available: ${patientIds.join(", ")}.`,
      },
    },
    required: ["patientId"],
    additionalProperties: false,
  },

  check_payer_rules: {
    type: "object",
    properties: {
      payer: {
        type: "string",
        enum: payerIds,
        description: `Insurer to submit to. Available: ${payerIds.join(", ")}. Each has its own required fields and coverage criteria.`,
      },
    },
    required: ["payer"],
    additionalProperties: false,
  },

  fill_field: {
    type: "object",
    properties: {
      fieldId: {
        type: "string",
        enum: fillableFieldIds,
        description: `Field to set. Call check_payer_rules first: the payer decides which of these are required. Fields: ${fillableFieldList}. The clinician-judgment fields (${judgmentFieldIds.join(", ")}) are not settable through this tool and will be refused; propose text for those with draft_field, which the clinician accepts or rejects.`,
      },
      value: {
        type: "string",
        description:
          "Value to write, sourced from the patient record. Coded fields are validated: diagnosis_code must be ICD-10 (e.g. M06.9), hcpcs_code must be a J-code (e.g. J0135), prescriber_npi must be exactly 10 digits.",
      },
    },
    required: ["fieldId", "value"],
    additionalProperties: false,
  },

  attach_evidence: {
    type: "object",
    properties: {
      fieldId: {
        type: "string",
        // Evidence fields only. This used to accept every field id, which made
        // it a second, unguarded way into the clinician-judgment fields: an
        // agent refused by fill_field could attach a document id over the
        // attestation instead, and validate_submission would then report the
        // clinician's work as done.
        enum: evidenceFieldIds,
        description: `Evidence field to attach the document to. Accepts: ${evidenceFieldIds.join(", ")}. Clinician-judgment fields are refused, as they are by fill_field.`,
      },
      docId: {
        type: "string",
        enum: docIds,
        description: `Document from the patient's chart. Available: ${docList}.`,
      },
    },
    required: ["fieldId", "docId"],
    additionalProperties: false,
  },

  validate_submission: { type: "object", properties: {}, additionalProperties: false },

  assess_denial_risk: { type: "object", properties: {}, additionalProperties: false },

  detect_conflicts: { type: "object", properties: {}, additionalProperties: false },

  draft_field: {
    type: "object",
    properties: {
      fieldId: {
        type: "string",
        enum: draftableFieldIds,
        description: `Clinician-judgment field to draft language for. Available: ${draftableFieldIds.join(", ")}. The draft is a proposal only and does not count as filled until the clinician accepts it.`,
      },
    },
    required: ["fieldId"],
    additionalProperties: false,
  },

  draft_appeal: { type: "object", properties: {}, additionalProperties: false },

  flag_for_human: {
    type: "object",
    properties: {
      fieldId: {
        type: "string",
        enum: fieldIds,
        description: "Field that needs clinician attention.",
      },
      reason: {
        type: "string",
        description: "Why the clinician needs to look at it, in one sentence.",
      },
    },
    required: ["fieldId", "reason"],
    additionalProperties: false,
  },

  submit: { type: "object", properties: {}, additionalProperties: false },
} as const;

/** Exposed so the guidance tool can describe the same codes the schema allows. */
export const knownHcpcs = hcpcsCodes;
