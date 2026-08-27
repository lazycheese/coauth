import { invokeTool } from "../mcp/registerTools";
import { useCoAuth } from "../store/coauthStore";

// The interface drives the same tools an agent does, but a click is a human
// action and has to be recorded as one. Every call from the UI goes through
// here, so attribution is a property of the call path rather than something
// each component has to remember to pass.

const HUMAN = { actor: "human" as const };

export const humanActions = {
  loadPatient: (patientId: string) => invokeTool("load_patient_context", { patientId }, HUMAN),
  choosePayer: (payer: string) => invokeTool("check_payer_rules", { payer }, HUMAN),
  fillField: (fieldId: string, value: string) => invokeTool("fill_field", { fieldId, value }, HUMAN),
  attachEvidence: (fieldId: string, docId: string) => invokeTool("attach_evidence", { fieldId, docId }, HUMAN),
  assessRisk: () => invokeTool("assess_denial_risk", {}, HUMAN),
  detectConflicts: () => invokeTool("detect_conflicts", {}, HUMAN),
  draftField: (fieldId: string) => invokeTool("draft_field", { fieldId }, HUMAN),
  draftAppeal: () => invokeTool("draft_appeal", {}, HUMAN),
  submit: () => invokeTool("submit", {}, HUMAN),
  reset: () => useCoAuth.getState().reset(),
};

// The scripted walkthrough replays what an agent would do, so those calls carry
// no human context and are attributed to the agent.
export const scriptedAgentActions = {
  guidance: () => invokeTool("get_workflow_guidance"),
  loadPatient: (patientId: string) => invokeTool("load_patient_context", { patientId }),
  choosePayer: (payer: string) => invokeTool("check_payer_rules", { payer }),
  fillField: (fieldId: string, value: string) => invokeTool("fill_field", { fieldId, value }),
  attachEvidence: (fieldId: string, docId: string) => invokeTool("attach_evidence", { fieldId, docId }),
  assessRisk: () => invokeTool("assess_denial_risk"),
  detectConflicts: () => invokeTool("detect_conflicts"),
  draftField: (fieldId: string) => invokeTool("draft_field", { fieldId }),
  submit: () => invokeTool("submit"),
};
