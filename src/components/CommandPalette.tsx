import { useEffect, useMemo, useState } from "react";
import { useCoAuth } from "../store/coauthStore";
import { tools } from "../mcp/registerTools";

const tool = (name: string) => tools.find((t) => t.name === name)!;

interface Command {
  label: string;
  hint: string;
  run: () => void | Promise<void>;
}

/** Agent auto-fills every non-judgment field for the loaded patient. */
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
      await tool("attach_evidence").execute({ fieldId: f.id, docId: "doc-tb" });
    } else if (map[f.id]) {
      await tool("fill_field").execute({ fieldId: f.id, value: map[f.id] });
    }
  }
  await tool("detect_conflicts").execute({});
  await tool("assess_denial_risk").execute({});
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
      { label: "Load patient - Jane Doe (clean)", hint: "load_patient_context", run: () => tool("load_patient_context").execute({ patientId: "jane-doe" }) },
      { label: "Load patient - Marcus Lee (denial risk)", hint: "load_patient_context", run: () => tool("load_patient_context").execute({ patientId: "marcus-lee" }) },
      { label: "Payer - UnitedHealthcare", hint: "check_payer_rules", run: () => tool("check_payer_rules").execute({ payer: "uhc" }) },
      { label: "Payer - Aetna", hint: "check_payer_rules", run: () => tool("check_payer_rules").execute({ payer: "aetna" }) },
      { label: "Payer - Cigna", hint: "check_payer_rules", run: () => tool("check_payer_rules").execute({ payer: "cigna" }) },
      { label: "Agent: auto-fill the form", hint: "fill_field ×N + checks", run: autofill },
      { label: "Agent: assess denial risk", hint: "assess_denial_risk", run: () => tool("assess_denial_risk").execute({}) },
      { label: "Agent: detect conflicts", hint: "detect_conflicts", run: () => tool("detect_conflicts").execute({}) },
      { label: "Agent: draft medical necessity", hint: "draft_field", run: () => tool("draft_field").execute({ fieldId: "medical_necessity" }) },
      { label: "Agent: draft appeal letter", hint: "draft_appeal", run: () => tool("draft_appeal").execute({}) },
      { label: "Agent: attempt submit", hint: "submit (gated)", run: () => tool("submit").execute({}) },
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
