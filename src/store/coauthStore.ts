import { create } from "zustand";
import type { Patient, PayerRules, EvidenceDoc } from "../data/seed";
import { validate, type ValidationSummary } from "../rules/validate";
import { assessRisk, detectConflicts, type RiskAssessment, type Conflict } from "../rules/risk";
import { postJson } from "../lib/http";

export interface ActivityEntry {
  id: number;
  actor: "agent" | "human";
  tool: string;
  summary: string;
  ts: number;
}

export interface AuditEntry {
  ts: number;
  attestation: string;
  signer: string;
  hash: string;
  /** "server" when the signature was minted and checked by the API. */
  verifiedBy: "server" | "client-only";
  confirmationId?: string;
  /** Set when the submission changed after this signature was given. */
  voided?: boolean;
}

export interface ApprovalToken {
  ts: number;
  attestation: string;
  signer: string;
  /** Local digest, shown in the audit trail. */
  hash: string;
  /** Present only for server-minted tokens; these are what submit verifies. */
  payer?: string;
  digest?: string;
  jti?: string;
  mac?: string;
  /** False means no signing service was reachable, so the gate is advisory. */
  serverVerified: boolean;
}

export interface Flag {
  fieldId: string;
  reason: string;
}

/** What a submission leaves behind on this device.
 *
 * Deliberately nothing that identifies a patient. The receipt is a confirmation
 * id, who it went to, and what the risk was; the record itself stays on the
 * server side of the story. Persisting a patient's name to browser storage is a
 * habit worth not forming, and the data being fictional here does not make it a
 * pattern worth shipping. */
export interface SubmittedPA {
  confirmationId: string;
  payer: string;
  riskAtSubmit: number;
  hash: string;
  ts: number;
}

// Bumped from v1, which stored patient names. Old entries are discarded rather
// than migrated, because the point is not to keep them.
const HISTORY_KEY = "coauth.history.v2";
const LEGACY_HISTORY_KEYS = ["coauth.history.v1"];

function loadHistory(): SubmittedPA[] {
  try {
    for (const old of LEGACY_HISTORY_KEYS) localStorage.removeItem(old);
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const stored = JSON.parse(raw) as SubmittedPA[];
    const kept = stored.filter((h) => h && !("patientName" in h));
    // Ignoring an identifier is not the same as removing it. If anything was
    // dropped, write the cleaned list back now rather than waiting for the next
    // submission to overwrite it.
    if (kept.length !== stored.length) {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(kept));
    }
    return kept;
  } catch {
    return [];
  }
}

function saveHistory(h: SubmittedPA[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, 25)));
  } catch {
    /* storage unavailable - history stays in-memory only */
  }
}

interface CoAuthState {
  patient: Patient | null;
  payerRules: PayerRules | null;
  docs: EvidenceDoc[];
  formFields: Record<string, unknown>;
  attachments: Record<string, string>; // fieldId -> docId
  validation: ValidationSummary | null;
  risk: RiskAssessment | null;
  conflicts: Conflict[];
  overrides: Record<string, string>;
  suggestions: Record<string, string>;
  provenance: Record<string, { by: "agent" | "clinician"; source?: string; verified?: boolean }>;
  appealDraft: string | null;
  history: SubmittedPA[];
  flags: Flag[];
  approvalToken: ApprovalToken | null;
  auditLog: AuditEntry[];
  activity: ActivityEntry[];
  focusedField: string | null;
  submitResult: { status: string; reason?: string; confirmationId?: string } | null;
  /** True when a signature was voided by a change and has not been replaced. */
  signatureVoided: boolean;
  /** Which scripted run, if any, is currently driving the workspace. */
  scriptedRun: "walkthrough" | "comparison" | null;
  toast: string | null;
  webmcpConnected: boolean;

  setPatient: (p: Patient) => void;
  setPayerRules: (r: PayerRules) => void;
  setDocs: (d: EvidenceDoc[]) => void;
  setField: (fieldId: string, value: unknown) => void;
  attach: (fieldId: string, docId: string) => void;
  runValidation: () => ValidationSummary;
  resolveConflict: (id: string, rationale: string) => void;
  setSuggestion: (fieldId: string, text: string) => void;
  acceptSuggestion: (fieldId: string) => void;
  setProvenance: (fieldId: string, info: { by: "agent" | "clinician"; source?: string; verified?: boolean }) => void;
  setAppealDraft: (text: string | null) => void;
  recordSubmission: (pa: SubmittedPA) => void;
  setToast: (msg: string | null) => void;
  setWebmcpConnected: (v: boolean) => void;
  setScriptedRun: (r: CoAuthState["scriptedRun"]) => void;
  addFlag: (fieldId: string, reason: string) => void;
  sign: (attestation: string, signer: string) => Promise<ApprovalToken>;
  clearApproval: () => void;
  logActivity: (actor: "agent" | "human", tool: string, summary: string) => void;
  setFocused: (fieldId: string | null) => void;
  setSubmitResult: (r: CoAuthState["submitResult"]) => void;
  reset: () => void;
}

let activitySeq = 0;

/** Changing the submission voids any signature covering it.
 *
 * The attestation is a statement about a specific set of values, so it cannot
 * survive them changing. The previous entry stays in the audit trail, marked as
 * voided, because a signature that was given and then superseded is part of the
 * history rather than something to erase. */
function invalidateApproval(s: CoAuthState): Partial<CoAuthState> {
  if (!s.approvalToken) return { submitResult: null };
  const auditLog = s.auditLog.map((e, i) =>
    i === s.auditLog.length - 1 && !e.confirmationId ? { ...e, voided: true } : e
  );
  return { approvalToken: null, submitResult: null, signatureVoided: true, auditLog };
}

// Deterministic, dependency-free hash of the current form state.
function hashFields(fields: Record<string, unknown>): string {
  const str = JSON.stringify(fields, Object.keys(fields).sort());
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return "sig_" + (h >>> 0).toString(16);
}

export const useCoAuth = create<CoAuthState>((set, get) => ({
  patient: null,
  payerRules: null,
  docs: [],
  formFields: {},
  attachments: {},
  validation: null,
  risk: null,
  conflicts: [],
  overrides: {},
  suggestions: {},
  provenance: {},
  appealDraft: null,
  history: loadHistory(),
  flags: [],
  approvalToken: null,
  auditLog: [],
  activity: [],
  focusedField: null,
  submitResult: null,
  signatureVoided: false,
  scriptedRun: null,
  toast: null,
  webmcpConnected: false,

  setToast: (msg) => set({ toast: msg }),
  setWebmcpConnected: (v) => set({ webmcpConnected: v }),
  setScriptedRun: (r) => set({ scriptedRun: r }),

  setPatient: (p) => set({ patient: p }),
  setPayerRules: (r) => set({ payerRules: r }),
  setDocs: (d) => set({ docs: d }),

  setField: (fieldId, value) => {
    // Editing any field invalidates a prior signature.
    set((s) => ({ formFields: { ...s.formFields, [fieldId]: value }, ...invalidateApproval(s) }));
  },

  attach: (fieldId, docId) =>
    // Attaching changes the submission, so it invalidates a signature for the
    // same reason editing a field does, and clears any stale result banner.
    set((s) => ({
      attachments: { ...s.attachments, [fieldId]: docId },
      formFields: { ...s.formFields, [fieldId]: docId },
      ...invalidateApproval(s),
    })),

  runValidation: () => {
    const s = get();
    const summary = validate(s.formFields, s.payerRules);
    const risk = assessRisk(s.formFields, s.patient, s.payerRules, s.overrides);
    const conflicts = detectConflicts(s.formFields, s.patient, s.payerRules, s.overrides);
    set({ validation: summary, risk, conflicts });
    return summary;
  },

  resolveConflict: (id, rationale) => {
    set((s) => ({ overrides: { ...s.overrides, [id]: rationale }, ...invalidateApproval(s) }));
    get().runValidation();
  },

  setSuggestion: (fieldId, text) => set((s) => ({ suggestions: { ...s.suggestions, [fieldId]: text } })),
  setProvenance: (fieldId, info) => set((s) => ({ provenance: { ...s.provenance, [fieldId]: info } })),
  setAppealDraft: (text) => set({ appealDraft: text }),

  recordSubmission: (pa) =>
    set((s) => {
      const history = [pa, ...s.history.filter((h) => h.confirmationId !== pa.confirmationId)];
      saveHistory(history);
      return { history };
    }),

  acceptSuggestion: (fieldId) => {
    const text = get().suggestions[fieldId];
    if (text == null) return;
    set((s) => {
      const { [fieldId]: _drop, ...rest } = s.suggestions;
      return {
        formFields: { ...s.formFields, [fieldId]: text },
        suggestions: rest,
        provenance: { ...s.provenance, [fieldId]: { by: "clinician", source: "accepted agent draft" } },
        approvalToken: null,
        submitResult: null,
      };
    });
    get().runValidation();
  },

  addFlag: (fieldId, reason) =>
    set((s) => ({
      flags: [...s.flags.filter((f) => f.fieldId !== fieldId), { fieldId, reason }],
    })),

  sign: async (attestation, signer) => {
    const s0 = get();
    const localHash = hashFields(s0.formFields);
    let token: ApprovalToken = {
      ts: Date.now(),
      attestation,
      signer,
      hash: localHash,
      serverVerified: false,
    };

    // Ask the signing service to mint the token. Only a server-minted token can
    // be verified at submit time, so this is what makes the gate real.
    try {
      const res = await postJson("/api/v1/sign", {
        payer: s0.payerRules?.id ?? "",
        formFields: s0.formFields,
        attestation,
        signer,
      });
      if (res.ok && res.json?.token) {
        const t = res.json.token;
        token = { ...token, ts: t.ts, payer: t.payer, digest: t.digest, jti: t.jti, mac: t.mac, serverVerified: true };
      } else {
        get().setToast("The signing service did not issue an approval, so this signature is local only and cannot be submitted.");
      }
    } catch {
      // Unreachable or too slow. The signature stays local, which submit will
      // refuse, and the audit trail records that it was never server-verified.
      get().setToast("The signing service could not be reached, so this signature is local only and cannot be submitted.");
    }

    set((s) => ({
      approvalToken: token,
      signatureVoided: false,
      auditLog: [
        ...s.auditLog,
        {
          ts: token.ts,
          attestation,
          signer,
          hash: token.digest ?? token.hash,
          verifiedBy: token.serverVerified ? "server" : "client-only",
        },
      ],
      submitResult: null,
    }));
    return token;
  },

  clearApproval: () => set({ approvalToken: null }),

  logActivity: (actor, tool, summary) =>
    set((s) => ({
      activity: [{ id: ++activitySeq, actor, tool, summary, ts: Date.now() }, ...s.activity],
    })),

  setFocused: (fieldId) => set({ focusedField: fieldId }),
  setSubmitResult: (r) => set({ submitResult: r }),

  reset: () =>
    set({
      patient: null, payerRules: null, docs: [], formFields: {}, attachments: {},
      validation: null, risk: null, conflicts: [], overrides: {}, suggestions: {}, provenance: {}, appealDraft: null, flags: [],
      approvalToken: null, auditLog: [], activity: [], focusedField: null, submitResult: null,
      signatureVoided: false,
    }),
}));

// Development-only inspection handle. Never shipped: exposing the live store on
// window would hand any script in the page a way to set approval state.
if (import.meta.env.DEV && typeof window !== "undefined") {
  const w = window as any;
  w.__coauth = w.__coauth || {};
  Object.defineProperty(w.__coauth, "state", { get: () => useCoAuth.getState(), configurable: true });
}
