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
  /** Always "server": no other kind of signature is recorded. */
  verifiedBy: "server";
  confirmationId?: string;
  /** Set when the submission changed after this signature was given. */
  voided?: boolean;
}

export interface ApprovalToken {
  ts: number;
  attestation: string;
  signer: string;
  /** Directory id and NPI of the authenticated clinician, from the session. */
  clinicianId: string;
  npi: string;
  /** Local digest, shown in the audit trail. */
  hash: string;
  /** Minted server-side over exactly these. */
  payer: string;
  patientId: string;
  digest: string;
  jti: string;
  mac: string;
  /** Always true: a token that is not server-verified is never constructed. */
  serverVerified: true;
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
  /** The same results keyed by field, so a row does not scan the list. */
  validationByField: Record<string, ValidationSummary["results"][number]>;
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
  submitResult: { status: string; reason?: string; confirmationId?: string; x12?: string } | null;
  /** True when a signature was voided by a change and has not been replaced. */
  signatureVoided: boolean;
  /** Which scripted run, if any, is currently driving the workspace. */
  scriptedRun: "walkthrough" | "comparison" | null;
  toast: string | null;
  webmcpConnected: boolean;
  /** Tools a runtime accepted, or null before one has answered. */
  webmcpRegistered: number | null;

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
  setWebmcpConnected: (v: boolean, registered?: number) => void;
  setScriptedRun: (r: CoAuthState["scriptedRun"]) => void;
  addFlag: (fieldId: string, reason: string) => void;
  /** Mints a server-verified approval, or null with a toast explaining why not.
   *  The passphrase is required per signature and is never stored. */
  sign: (attestation: string, passphrase: string) => Promise<ApprovalToken | null>;
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
  // A confirmed submission is a receipt, not a draft. Editing the form
  // afterwards used to null submitResult and raise "the signature no longer
  // applies", wiping the confirmation id off the screen just when someone might
  // need to write it down. The filing already happened; leave it visible.
  if (s.submitResult?.status === "submitted") return {};
  if (!s.approvalToken) return { submitResult: null };
  const auditLog = s.auditLog.map((e, i) =>
    i === s.auditLog.length - 1 && !e.confirmationId ? { ...e, voided: true } : e
  );
  return { approvalToken: null, submitResult: null, signatureVoided: true, auditLog };
}

/** Deterministic, dependency-free hash of the current form state.
 *
 * Serialized in the same shape as the server's canonicalize(): an array of
 * sorted [key, value] pairs. The previous version passed the sorted key list as
 * JSON.stringify's second argument, which is a replacer allowlist that only
 * incidentally fixed key order - and which would have silently filtered the
 * inner keys of any non-flat value. */
function hashFields(fields: Record<string, unknown>, overrides: Record<string, string> = {}): string {
  const keys = Object.keys(fields ?? {}).sort();
  const oKeys = Object.keys(overrides ?? {}).sort();
  const str = JSON.stringify([
    keys.map((k) => [k, fields[k] ?? null]),
    oKeys.map((k) => [k, overrides[k] ?? null]),
  ]);
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
  validationByField: {},
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
  webmcpRegistered: null,

  setToast: (msg) => set({ toast: msg }),
  setWebmcpConnected: (v, registered) =>
    set(registered === undefined ? { webmcpConnected: v } : { webmcpConnected: v, webmcpRegistered: registered }),
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
    const validationByField = Object.fromEntries(summary.results.map((r) => [r.fieldId, r]));
    set({ validation: summary, validationByField, risk, conflicts });
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
        // Accepting a draft changes the submission, so it voids a signature for
        // exactly the same reason editing a field does. Clearing the token by
        // hand here left signatureVoided false and the audit row reading live.
        ...invalidateApproval(s),
      };
    });
    get().runValidation();
  },

  addFlag: (fieldId, reason) =>
    set((s) => ({
      flags: [...s.flags.filter((f) => f.fieldId !== fieldId), { fieldId, reason }],
    })),

  sign: async (attestation, passphrase) => {
    const s0 = get();
    // Covers the overrides as well as the fields. Recording an override runs
    // invalidateApproval, but it leaves formFields untouched - so a guard that
    // hashed only the fields would pass, and the token would be reinstated over
    // the override set that was current when signing began.
    const localHash = hashFields(s0.formFields, s0.overrides);

    // Ask the signing service to mint the token. Only a server-minted token can
    // be verified at submit time, and minting requires an authenticated
    // clinician session, so this is what makes the gate real. The signer's
    // identity comes back from the session; it is deliberately not sent, so it
    // cannot be chosen by whatever is driving the page.
    let token: ApprovalToken;
    try {
      const res = await postJson("/api/v1/sign", {
        payer: s0.payerRules?.id ?? "",
        patientId: s0.patient?.id ?? "",
        formFields: s0.formFields,
        overrides: s0.overrides,
        attestation,
        // Sent, never kept. It is not in the store, not in the token, and not
        // in the audit trail.
        passphrase,
      });
      if (!res.ok || !res.json?.token) {
        const code = res.json?.error?.code;
        get().setToast(
          code === "authentication_required"
            ? "Sign in as a clinician before signing. An approval is minted for an authenticated clinician and for nobody else."
            : code === "reauthentication_required"
            ? "That passphrase was not accepted. Signing asks for it again each time, because a session alone is something a script in this page also has."
            : res.json?.error?.message ?? "The signing service did not issue an approval, so nothing was signed."
        );
        return null;
      }
      const t = res.json.token;
      token = {
        ts: t.ts,
        attestation,
        signer: t.signer,
        clinicianId: t.clinicianId,
        npi: t.npi,
        hash: localHash,
        payer: t.payer,
        patientId: t.patientId,
        digest: t.digest,
        jti: t.jti,
        mac: t.mac,
        serverVerified: true,
      };
    } catch {
      get().setToast("The signing service could not be reached, so nothing was signed. Try again shortly.");
      return null;
    }

    // The form can be edited while the request is open. An edit runs
    // invalidateApproval; writing the token unconditionally here would resurrect
    // it over values the clinician never saw and clear the voided flag, leaving
    // a signature on screen that covers a different form. Discard instead.
    if (hashFields(get().formFields, get().overrides) !== localHash) {
      get().setToast("The submission changed while the signature was being issued, so it was discarded. Review the current values and sign again.");
      return null;
    }

    set((s) => ({
      approvalToken: token,
      signatureVoided: false,
      auditLog: [
        ...s.auditLog,
        {
          ts: token.ts,
          attestation,
          signer: token.signer,
          hash: token.digest ?? token.hash,
          verifiedBy: "server",
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
      validation: null, validationByField: {}, risk: null, conflicts: [], overrides: {}, suggestions: {}, provenance: {}, appealDraft: null, flags: [],
      approvalToken: null, auditLog: [], activity: [], focusedField: null, submitResult: null,
      signatureVoided: false,
      // Left stuck across a reset, this blocked every subsequent scripted run.
      scriptedRun: null,
    }),
}));

// Development-only inspection handle. Never shipped: exposing the live store on
// window would hand any script in the page a way to set approval state.
if (import.meta.env.DEV && typeof window !== "undefined") {
  const w = window as any;
  w.__coauth = w.__coauth || {};
  Object.defineProperty(w.__coauth, "state", { get: () => useCoAuth.getState(), configurable: true });
}
