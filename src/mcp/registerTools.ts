import { useCoAuth } from "../store/coauthStore";
import { docs as seedDocs, getPatient, getPayerRules, resolveSourceValue } from "../data/seed";
import { draftFor, draftAppeal } from "../rules/drafts";
import { schemas } from "./schemas";

declare const __STATIC_HOST__: boolean;
const STATIC_HOST = typeof __STATIC_HOST__ !== "undefined" && __STATIC_HOST__;

type ToolResult = Record<string, unknown>;
type Executor = (input: any) => Promise<ToolResult> | ToolResult;

interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: unknown;
  readOnlyHint: boolean;
  execute: Executor;
}

const store = () => useCoAuth.getState();

function summarize(v: ReturnType<typeof store>["validation"]) {
  if (!v) return null;
  return {
    failCount: v.failCount,
    judgmentCount: v.judgmentCount,
    passCount: v.passCount,
    clearForSignature: v.clearForSignature,
    pending: v.results.filter((r) => !r.ok).map((r) => ({ fieldId: r.fieldId, label: r.label, requiresHumanJudgment: r.requiresHumanJudgment })),
  };
}

export const tools: ToolDef[] = [
  {
    name: "load_patient_context",
    title: "Load patient context",
    description: "Load a patient's structured clinical record into the workspace.",
    inputSchema: schemas.load_patient_context,
    readOnlyHint: true,
    execute: async ({ patientId }) => {
      // Prefer the API (Vercel); fall back to in-bundle seed (e.g. static hosting).
      let patient: ReturnType<typeof getPatient> | undefined;
      if (!STATIC_HOST) {
        try {
          const res = await fetch(`/api/patient/${encodeURIComponent(patientId)}`);
          if (res.ok) patient = await res.json();
        } catch {
          /* no API - use local seed */
        }
      }
      if (!patient) patient = getPatient(patientId);
      if (!patient) {
        store().setToast(`Patient “${patientId}” not found.`);
        return { status: "error", reason: "patient not found" };
      }
      store().setPatient(patient);
      store().setDocs(seedDocs);
      store().logActivity("agent", "load_patient_context", `${patient.name} (${patient.diagnoses?.[0]?.code})`);
      return { status: "ok", patient: { name: patient.name, diagnosis: patient.diagnoses?.[0], medsTried: patient.medsTried } };
    },
  },
  {
    name: "check_payer_rules",
    title: "Check payer rules",
    description: "Fetch the payer's required fields and rules for the requested drug.",
    inputSchema: schemas.check_payer_rules,
    readOnlyHint: true,
    execute: async ({ payer }) => {
      let rules: ReturnType<typeof getPayerRules> | undefined;
      if (!STATIC_HOST) {
        try {
          const res = await fetch(`/api/payer-rules?payer=${encodeURIComponent(payer)}`);
          if (res.ok) rules = await res.json();
        } catch {
          /* no API - use local seed */
        }
      }
      if (!rules) rules = getPayerRules(payer);
      if (!rules) {
        store().setToast(`Payer “${payer}” not found.`);
        return { status: "error", reason: "payer not found" };
      }
      store().setPayerRules(rules);
      store().runValidation();
      store().logActivity("agent", "check_payer_rules", `${rules.name}: ${rules.requiredFields.length} required fields`);
      return { status: "ok", payer: rules.name, requiredFields: rules.requiredFields.map((f: any) => ({ id: f.id, label: f.label, requiresHumanJudgment: !!f.requiresHumanJudgment })) };
    },
  },
  {
    name: "fill_field",
    title: "Fill a form field",
    description: "Set the value of one required field. Do not fill fields that require human judgment.",
    inputSchema: schemas.fill_field,
    readOnlyHint: false,
    execute: ({ fieldId, value }) => {
      store().setField(fieldId, value);
      const src = store().payerRules?.requiredFields.find((f) => f.id === fieldId)?.source;
      // Verify: does the value actually match the record's scalar source value?
      const expected = resolveSourceValue(src, store().patient);
      const verified = expected !== undefined && String(value).trim() === String(expected).trim();
      store().setProvenance(fieldId, { by: "agent", source: src, verified });
      const v = store().runValidation();
      store().logActivity("agent", "fill_field", `${fieldId} = ${String(value).slice(0, 40)}`);
      return { status: "ok", fieldId, source: src, verifiedAgainstRecord: verified, validation: summarize(v) };
    },
  },
  {
    name: "attach_evidence",
    title: "Attach evidence",
    description: "Link a clinical document to a field that requires supporting evidence.",
    inputSchema: schemas.attach_evidence,
    readOnlyHint: false,
    execute: ({ fieldId, docId }) => {
      store().attach(fieldId, docId);
      store().setProvenance(fieldId, { by: "agent", source: "attached document" });
      const v = store().runValidation();
      store().logActivity("agent", "attach_evidence", `${docId} -> ${fieldId}`);
      return { status: "ok", fieldId, docId, validation: summarize(v) };
    },
  },
  {
    name: "validate_submission",
    title: "Validate submission",
    description: "Run the payer rules engine and report which fields pass, fail, or need human judgment.",
    inputSchema: schemas.validate_submission,
    readOnlyHint: true,
    execute: () => {
      const v = store().runValidation();
      store().logActivity("agent", "validate_submission", `${v.failCount} missing, ${v.judgmentCount} need clinician`);
      return { status: "ok", validation: summarize(v) };
    },
  },
  {
    name: "get_workflow_guidance",
    title: "Get workflow guidance",
    description: "Return the recommended sequence for completing a prior authorization and the rules the agent must follow (e.g. never fabricate clinician-judgment fields, never bypass the signature gate). Call this first to learn how to drive this page correctly.",
    inputSchema: schemas.get_workflow_guidance,
    readOnlyHint: true,
    execute: () => {
      const guidance = {
        recommendedSequence: [
          "load_patient_context",
          "check_payer_rules",
          "fill_field (for every non-judgment required field, sourced from the patient record)",
          "attach_evidence (for evidence fields)",
          "detect_conflicts (surface contraindications for the clinician)",
          "assess_denial_risk",
          "draft_field (propose clinician-judgment language - suggestion only)",
          "validate_submission",
          "submit (will be BLOCKED until the clinician signs)",
        ],
        rules: [
          "Never fill or fabricate a field marked requiresHumanJudgment - draft_field proposes; only the clinician accepts.",
          "Never resolve a critical conflict yourself - surface it; the clinician records the override.",
          "submit requires a human signature; relay the block to the clinician rather than retrying.",
        ],
        safety: { writeToolsChangeState: true, submitRequiresHumanSignature: true },
      };
      store().logActivity("agent", "get_workflow_guidance", "Read recommended workflow & safety rules");
      return { status: "ok", guidance };
    },
  },
  {
    name: "assess_denial_risk",
    title: "Assess denial risk",
    description: "Return a heuristic denial-risk score (rule-based, not a trained model) for the current submission, plus the contributing factors.",
    inputSchema: schemas.assess_denial_risk,
    readOnlyHint: true,
    execute: () => {
      store().runValidation();
      const r = store().risk;
      store().logActivity("agent", "assess_denial_risk", r ? `${r.score}% denial risk (${r.band})` : "no data");
      return { status: "ok", risk: r };
    },
  },
  {
    name: "detect_conflicts",
    title: "Detect clinical conflicts",
    description: "Check the request against the patient record for clinical contradictions (e.g. contraindications, unmet step therapy) that a clinician must review.",
    inputSchema: schemas.detect_conflicts,
    readOnlyHint: true,
    execute: () => {
      store().runValidation();
      const conflicts = store().conflicts;
      const critical = conflicts.filter((c) => c.requiresHumanOverride).length;
      store().logActivity("agent", "detect_conflicts", conflicts.length ? `${conflicts.length} found (${critical} need clinician override)` : "none");
      return { status: "ok", conflicts, requiresHumanOverride: critical > 0 };
    },
  },
  {
    name: "draft_appeal",
    title: "Draft appeal letter",
    description: "Draft a payer appeal letter for a denied or high-risk prior authorization, grounded in the patient record, the payer's policy, and the specific denial drivers. Draft only - requires clinician review and signature.",
    inputSchema: schemas.draft_appeal,
    readOnlyHint: true,
    execute: () => {
      const s = store();
      s.runValidation();
      const letter = draftAppeal(s.patient, s.payerRules, s.risk);
      if (!letter) return { status: "error", reason: "load patient and payer first" };
      s.setAppealDraft(letter);
      s.logActivity("agent", "draft_appeal", "Drafted appeal letter (awaiting clinician review)");
      return { status: "ok", letter, note: "Draft only - clinician must review & sign." };
    },
  },
  {
    name: "draft_field",
    title: "Draft judgment-field text",
    description: "Propose grounded draft language for a clinician-judgment field (e.g. medical necessity). The draft is a suggestion only - the clinician must review, edit, and accept it. Never counts as filled until accepted.",
    inputSchema: schemas.draft_field,
    readOnlyHint: true,
    execute: ({ fieldId }) => {
      const draft = draftFor(fieldId, store().patient);
      if (!draft) return { status: "error", reason: "no draft available for this field" };
      store().setSuggestion(fieldId, draft);
      store().logActivity("agent", "draft_field", `Proposed draft for ${fieldId} (awaiting clinician review)`);
      return { status: "ok", fieldId, draft, note: "Suggestion only - requires clinician acceptance." };
    },
  },
  {
    name: "flag_for_human",
    title: "Flag for human",
    description: "Mark a field as needing clinician input; surfaces it in the review queue.",
    inputSchema: schemas.flag_for_human,
    readOnlyHint: false,
    execute: ({ fieldId, reason }) => {
      store().addFlag(fieldId, reason);
      store().logActivity("agent", "flag_for_human", `${fieldId}: ${reason}`);
      return { status: "ok", fieldId, reason };
    },
  },
  {
    name: "submit",
    title: "Submit prior authorization",
    description: "Submit the completed prior authorization. Requires a human clinician signature first.",
    inputSchema: schemas.submit,
    readOnlyHint: false,
    execute: () => {
      const s = store();
      const v = s.runValidation();
      const unresolvedCritical = s.conflicts.filter((c) => c.requiresHumanOverride && !s.overrides[c.id]);
      if (unresolvedCritical.length) {
        s.logActivity("agent", "submit", `BLOCKED - ${unresolvedCritical.length} critical conflict(s) need clinician override`);
        const blocked = { status: "blocked", reason: "Critical clinical conflict requires clinician override before submission.", conflicts: unresolvedCritical };
        s.setSubmitResult({ status: "blocked", reason: blocked.reason });
        return blocked;
      }
      if (!s.approvalToken) {
        s.logActivity("agent", "submit", "BLOCKED - awaiting human signature");
        const blocked = {
          status: "blocked",
          reason: "Human clinician signature required before submission.",
          pending: summarize(v)?.pending ?? [],
        };
        s.setSubmitResult({ status: "blocked", reason: blocked.reason });
        return blocked;
      }
      const confirmationId = "PA-" + s.approvalToken.hash.replace("sig_", "").toUpperCase();
      s.auditLog[s.auditLog.length - 1] && (s.auditLog[s.auditLog.length - 1].confirmationId = confirmationId);
      useCoAuth.setState({ auditLog: [...s.auditLog] });
      s.setSubmitResult({ status: "submitted", confirmationId });
      s.recordSubmission({
        confirmationId,
        patientName: s.patient?.name ?? "-",
        payer: s.payerRules?.name ?? "-",
        riskAtSubmit: s.risk?.score ?? 0,
        hash: s.approvalToken.hash,
        ts: s.approvalToken.ts,
      });
      s.logActivity("agent", "submit", `Submitted - ${confirmationId}`);
      return { status: "submitted", confirmationId, auditId: s.approvalToken.hash };
    },
  },
];

/** Resolve every WebMCP surface this browser might expose.
 * Spec migrated navigator.modelContext -> document.modelContext (Chrome 150),
 * so we register on whichever exist to survive across browser/agent versions. */
function modelContexts(): any[] {
  const surfaces: any[] = [];
  const d = (document as any).modelContext;
  const n = (navigator as any).modelContext;
  if (d && typeof d.registerTool === "function") surfaces.push(d);
  if (n && typeof n.registerTool === "function" && n !== d) surfaces.push(n);
  return surfaces;
}

/** Register all tools with WebMCP if available, and always mirror on window for UI + verification. */
export function registerTools() {
  const surfaces = modelContexts();
  const toolPayload = (t: ToolDef) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: { readOnlyHint: t.readOnlyHint },
    // WebMCP expects results as { content: [{type:'text', text}] }; wrap our JSON.
    execute: async (input: unknown) => {
      const result = await t.execute(input);
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    },
  });
  let registered = 0;
  for (const md of surfaces) {
    for (const t of tools) {
      try {
        md.registerTool(toolPayload(t));
        registered++;
      } catch {
        /* surface rejected this tool shape; other surfaces still try */
      }
    }
  }
  const mirror: Record<string, Executor> = {};
  for (const t of tools) mirror[t.name] = t.execute;
  const w = window as any;
  w.__coauth = w.__coauth || {};
  // Assign props (do NOT spread - that would snapshot the `state` getter).
  w.__coauth.tools = mirror;
  w.__coauth.webmcp = surfaces.length > 0;
  w.__coauth.registeredCount = registered;
  w.__coauth.toolCount = tools.length;
  // Allow re-running registration (e.g. after a runtime attaches, or for verification).
  w.__coauth._registerTools = registerTools;
  if (surfaces.length > 0) useCoAuth.getState().setWebmcpConnected(true);
  return surfaces.length > 0;
}

/** Register now, and keep watching briefly in case a WebMCP runtime attaches
 * after initial load (avoids a timing race with the browser/agent). */
export function registerToolsWithRetry() {
  if (registerTools()) return;
  let tries = 0;
  const id = setInterval(() => {
    tries++;
    if (registerTools() || tries >= 20) clearInterval(id);
  }, 500);
}
