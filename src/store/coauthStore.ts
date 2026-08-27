import { create } from "zustand";
import type { Patient, PayerRules, EvidenceDoc } from "../data/seed";
import { validate, type ValidationSummary } from "../rules/validate";
import { assessRisk, detectConflicts, type RiskAssessment, type Conflict } from "../rules/risk";

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
  mac?: string;
  /** False means no signing service was reachable, so the gate is advisory. */
  serverVerified: boolean;
}

export interface Flag {
  fieldId: string;
  reason: string;
}

export interface SubmittedPA {
  confirmationId: string;
  patientName: string;
  payer: string;
  riskAtSubmit: number;
  hash: string;
  ts: number;
}

const HISTORY_KEY = "coauth.history.v1";

function loadHistory(): SubmittedPA[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? (JSON.parse(raw) as SubmittedPA[]) : [];
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
  addFlag: (fieldId: string, reason: string) => void;
  sign: (attestation: string, signer: string) => Promise<ApprovalToken>;
  clearApproval: () => void;
  logActivity: (actor: "agent" | "human", tool: string, summary: string) => void;
  setFocused: (fieldId: string | null) => void;
  setSubmitResult: (r: CoAuthState["submitResult"]) => void;
  reset: () => void;
}

declare const __STATIC_HOST__: boolean;
const STATIC_HOST = typeof __STATIC_HOST__ !== "undefined" && __STATIC_HOST__;

let activitySeq = 0;

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
  toast: null,
  webmcpConnected: false,

  setToast: (msg) => set({ toast: msg }),
  setWebmcpConnected: (v) => set({ webmcpConnected: v }),

  setPatient: (p) => set({ patient: p }),
  setPayerRules: (r) => set({ payerRules: r }),
  setDocs: (d) => set({ docs: d }),

  setField: (fieldId, value) => {
    // Editing any field invalidates a prior signature.
    set((s) => ({ formFields: { ...s.formFields, [fieldId]: value }, approvalToken: null, submitResult: null }));
  },

  attach: (fieldId, docId) =>
    set((s) => ({
      attachments: { ...s.attachments, [fieldId]: docId },
      formFields: { ...s.formFields, [fieldId]: docId },
      approvalToken: null,
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
    set((s) => ({ overrides: { ...s.overrides, [id]: rationale }, approvalToken: null, submitResult: null }));
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
    if (!STATIC_HOST) {
      try {
        const res = await fetch("/api/v1/sign", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            payer: s0.payerRules?.id ?? "",
            formFields: s0.formFields,
            attestation,
            signer,
          }),
        });
        if (res.ok) {
          const { token: t } = await res.json();
          token = { ...token, ts: t.ts, payer: t.payer, digest: t.digest, mac: t.mac, serverVerified: true };
        }
      } catch {
        /* signing service unreachable; fall through to an advisory local token */
      }
    }

    set((s) => ({
      approvalToken: token,
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
    }),
}));

// Debug handle for live Playwright verification.
if (typeof window !== "undefined") {
  (window as unknown as { __coauth: unknown }).__coauth = {
    get state() {
      return useCoAuth.getState();
    },
  };
}
