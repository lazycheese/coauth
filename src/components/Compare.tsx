import { useState } from "react";

interface Step { t: string; label: string; kind: "info" | "warn" | "error" | "ok"; }

const BASELINE: Step[] = [
  { t: "0.0s", label: "Snapshotting DOM - 312 nodes, 41 inputs", kind: "info" },
  { t: "1.4s", label: "Locating “Member ID” by label proximity…", kind: "info" },
  { t: "3.1s", label: "Filled Diagnosis = “Rheumatoid arthritis” (expected ICD-10 code)", kind: "warn" },
  { t: "6.8s", label: "Cookie/consent modal intercepted click", kind: "warn" },
  { t: "9.2s", label: "Re-reading DOM after layout shift…", kind: "info" },
  { t: "14.0s", label: "Session-timeout dialog - unhandled", kind: "error" },
  { t: "19.5s", label: "Submitted to a “thank you” page - read as success", kind: "warn" },
  { t: "23 steps", label: "Gave up · 2 errors · no conflict check · high denial risk", kind: "error" },
];

const COAUTH: Step[] = [
  { t: "0.0s", label: "load_patient_context: structured record", kind: "ok" },
  { t: "0.4s", label: "check_payer_rules: 9 typed fields", kind: "ok" },
  { t: "1.1s", label: "fill_field x6: ICD-10, HCPCS, dose, step therapy", kind: "ok" },
  { t: "1.9s", label: "detect_conflicts: caught TB contraindication", kind: "ok" },
  { t: "2.3s", label: "assess_denial_risk: 46%, flagged for clinician", kind: "ok" },
  { t: "2.6s", label: "submit: blocked, awaiting clinician signature", kind: "warn" },
  { t: "9 calls", label: "0 errors, conflict caught, human-gated, audit-logged", kind: "ok" },
];

function Column({ title, tag, steps, shown, accent }: { title: string; tag: string; steps: Step[]; shown: number; accent: string }) {
  return (
    <div className={`cmp-col cmp-${accent}`}>
      <div className="cmp-col-head">
        <strong>{title}</strong>
        <span className="cmp-tag">{tag}</span>
      </div>
      <div className="cmp-steps">
        {steps.slice(0, shown).map((s, i) => (
          <div key={i} className={`cmp-step kind-${s.kind}`}>
            <span className="cmp-t">{s.t}</span>
            <span>{s.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Compare({ onClose }: { onClose: () => void }) {
  const [b, setB] = useState(0);
  const [c, setC] = useState(0);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);

  const run = () => {
    setB(0); setC(0); setDone(false); setRunning(true);
    let bi = 0, ci = 0;
    const bt = setInterval(() => { bi++; setB(bi); if (bi >= BASELINE.length) clearInterval(bt); }, 620);
    const ct = setInterval(() => { ci++; setC(ci); if (ci >= COAUTH.length) { clearInterval(ct); setRunning(false); setDone(true); } }, 430);
  };

  return (
    <div className="cmp-overlay" data-testid="compare-overlay">
      <div className="cmp-modal">
        <div className="cmp-head">
          <div>
            <h2>Same task, two agents</h2>
            <p className="muted">Illustrative only - the baseline steps and metrics below are <strong>not measured</strong>; they depict documented browser-agent failure modes on write-heavy forms (Web Bench, 2026). The CoAuth side reflects this app's actual tool sequence.</p>
          </div>
          <div className="cmp-actions">
            <button className="btn btn-primary" data-testid="compare-run" onClick={run} disabled={running}>{done ? "Replay" : "Run comparison"}</button>
            <button className="btn" onClick={onClose}>Close</button>
          </div>
        </div>

        <div className="cmp-grid">
          <Column title="Baseline agent" tag="DOM scraping · illustrative" steps={BASELINE} shown={b} accent="bad" />
          <Column title="CoAuth" tag="WebMCP tools" steps={COAUTH} shown={c} accent="good" />
        </div>

        <div className="cmp-metrics" data-testid="compare-metrics" data-done={done ? "1" : "0"}>
          <div className="cmp-metric"><span>Steps</span><b className="bad">23</b><b className="good">9</b></div>
          <div className="cmp-metric"><span>Errors</span><b className="bad">2</b><b className="good">0</b></div>
          <div className="cmp-metric"><span>Wall-clock</span><b className="bad">~48s</b><b className="good">~4s</b></div>
          <div className="cmp-metric"><span>Conflict check</span><b className="bad">None</b><b className="good">Yes</b></div>
          <div className="cmp-metric"><span>Outcome</span><b className="bad">Failed</b><b className="good">Clinician-ready</b></div>
        </div>
      </div>
    </div>
  );
}
