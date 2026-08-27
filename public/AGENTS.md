# AGENTS.md - CoAuth

CoAuth is an agent-native prior-authorization cockpit. This page exposes
**WebMCP tools** so an AI agent can complete a health-insurance prior
authorization together with a human clinician.

## How to drive this site

1. Call `get_workflow_guidance` first to learn the recommended sequence and the
   safety rules.
2. `load_patient_context({ patientId })` - patients: `jane-doe`, `marcus-lee`.
3. `check_payer_rules({ payer })` - payers: `uhc`, `aetna`, `cigna`.
4. `fill_field({ fieldId, value })` for every required field that is **not**
   marked `requiresHumanJudgment`. Source values from the patient record.
5. `attach_evidence({ fieldId, docId })` for evidence fields.
6. `detect_conflicts()` and `assess_denial_risk()` - surface issues for the
   clinician.
7. `draft_field({ fieldId })` to *propose* clinician-judgment text (a suggestion
   only; the clinician accepts it).
8. `validate_submission()` to check completeness and field formats.
9. `submit()` - will return `blocked` until a human clinician signs.

## Rules the agent must follow

- Never fill or fabricate a field marked `requiresHumanJudgment`.
- Never resolve a critical clinical conflict (e.g. a contraindication) yourself -
  surface it; the clinician records the override.
- `submit` requires a human signature. If it returns `blocked`, relay that to the
  clinician rather than retrying.

## Tools

`get_workflow_guidance`, `get_submission_state`, `load_patient_context`, `check_payer_rules`,
`fill_field`, `attach_evidence`, `validate_submission`, `assess_denial_risk`,
`detect_conflicts`, `draft_field`, `draft_appeal`, `flag_for_human`, `submit`.

Registered on both `document.modelContext` and `navigator.modelContext`.
