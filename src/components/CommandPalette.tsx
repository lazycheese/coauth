import { useEffect, useMemo, useState } from "react";
import { useCoAuth } from "../store/coauthStore";
import { humanActions } from "../app/actions";

interface Command {
  label: string;
  hint: string;
  run: () => void | Promise<void>;
}

/** Fills every non-judgment field for the loaded patient via the WebMCP tools. */
async function autofill() {
  const s = useCoAuth.getState();
  const p = s.patient;
  const rules = s.payerRules;
  if (!p || !rules) return;
  const map: Record<string, string> = {
    member_id: p.memberId,
    prescriber_npi: "1487203941",
    diagnosis_code: p.diagnoses[0].code,
    hcpcs_code: "J0135",
    dose: "40 mg SC every other week",
    quantity: "2 syringes / 28 days",
    step_therapy: p.medsTried.map((m) => `${m.name} ${m.durationMonths}mo - ${m.outcome}`).join("; "),
  };
  for (const f of rules.requiredFields) {
    if (f.requiresHumanJudgment) continue;
    if (f.type === "evidence") {
      await humanActions.attachEvidence(f.id, "doc-tb");
    } else if (map[f.id]) {
      await humanActions.fillField(f.id, map[f.id]);
    }
  }
  await humanActions.detectConflicts();
  await humanActions.assessRisk();
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [qs, setQs] = useState("");
  const reset = useCoAuth((s) => s.reset);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) setQs("");
  }, [open]);

  const commands: Command[] = useMemo(
    () => [
      { label: "Load patient - Jane Doe (clean)", hint: "load_patient_context", run: () => humanActions.loadPatient("jane-doe") },
      { label: "Load patient - Marcus Lee (denial risk)", hint: "load_patient_context", run: () => humanActions.loadPatient("marcus-lee") },
      { label: "Load patient - Ana Torres (etanercept, coverage check)", hint: "load_patient_context", run: () => humanActions.loadPatient("ana-torres") },
      { label: "Payer - UnitedHealthcare", hint: "check_payer_rules", run: () => humanActions.choosePayer("uhc") },
      { label: "Payer - Aetna", hint: "check_payer_rules", run: () => humanActions.choosePayer("aetna") },
      { label: "Payer - Cigna", hint: "check_payer_rules", run: () => humanActions.choosePayer("cigna") },
      { label: "Run auto-fill the form", hint: "fill_field ×N + checks", run: autofill },
      { label: "Run assess denial risk", hint: "assess_denial_risk", run: () => humanActions.assessRisk() },
      { label: "Run detect conflicts", hint: "detect_conflicts", run: () => humanActions.detectConflicts() },
      { label: "Run draft medical necessity", hint: "draft_field", run: () => humanActions.draftField("medical_necessity") },
      { label: "Run draft appeal letter", hint: "draft_appeal", run: () => humanActions.draftAppeal() },
      { label: "Run attempt submit", hint: "submit (gated)", run: () => humanActions.submit() },
      { label: "Reset workspace", hint: "reset", run: () => reset() },
    ],
    [reset]
  );

  const filtered = commands.filter((c) => c.label.toLowerCase().includes(qs.toLowerCase()) || c.hint.includes(qs.toLowerCase()));

  if (!open) return null;
  return (
    <div className="cmd-overlay" data-testid="command-palette" onClick={() => setOpen(false)}>
      <div className="cmd-box" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          className="cmd-input"
          data-testid="cmd-input"
          placeholder="Run a WebMCP tool (Cmd K / Esc)"
          value={qs}
          onChange={(e) => setQs(e.target.value)}
        />
        <div className="cmd-list">
          {filtered.map((c) => (
            <button
              key={c.label}
              className="cmd-item"
              onClick={async () => {
                setOpen(false);
                await c.run();
              }}
            >
              <span>{c.label}</span>
              <span className="cmd-hint">{c.hint}</span>
            </button>
          ))}
          {filtered.length === 0 && <div className="cmd-empty muted">No matching tool.</div>}
        </div>
      </div>
    </div>
  );
}
