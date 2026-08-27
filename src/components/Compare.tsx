import { useState } from "react";
import { useCoAuth } from "../store/coauthStore";
import { humanActions } from "../app/actions";
import { runBaseline, runToolPath, type RunMetrics } from "../demo/baseline";

type Phase = "idle" | "running" | "done";

function MetricRow({ label, a, b, better }: { label: string; a: string; b: string; better: "low" | "high" | "none" }) {
  // "better" only drives colour; the values themselves are measured.
  return (
    <div className="cmp-metric-row">
      <span className="cmp-metric-label">{label}</span>
      <b className={better === "none" ? "" : "bad"}>{a}</b>
      <b className={better === "none" ? "" : "good"}>{b}</b>
    </div>
  );
}

export function Compare({ onClose }: { onClose: () => void }) {
  const reset = useCoAuth((s) => s.reset);
  const [phase, setPhase] = useState<Phase>("idle");
  const [step, setStep] = useState<string>("");
  const [baseline, setBaseline] = useState<RunMetrics | null>(null);
  const [tools, setTools] = useState<RunMetrics | null>(null);

  const run = async () => {
    setPhase("running");
    setBaseline(null);
    setTools(null);

    // Same patient, same payer, same form, one run each.
    const setup = async () => {
      reset();
      await humanActions.loadPatient("marcus-lee");
      await humanActions.choosePayer("aetna");
    };

    await setup();
    setStep("Running the DOM-driven baseline");
    const b = await runBaseline((s) => setStep(`Baseline: ${s}`));
    setBaseline(b);

    await setup();
    setStep("Running the same task through the tools");
    const t = await runToolPath((s) => setStep(`Tools: ${s}`));
    setTools(t);

    setStep("");
    setPhase("done");
  };

  return (
    <div className="cmp-overlay" data-testid="compare-overlay">
      <div className="cmp-modal">
        <div className="cmp-head">
          <div>
            <h2>Same form, with and without tools</h2>
            <p className="muted">
              Both runs happen in this browser when you press the button, against the same patient and payer.
              Every number below is measured from those two runs. Nothing here is pre-written.
            </p>
          </div>
          <div className="cmp-actions">
            <button className="btn btn-primary" data-testid="compare-run" onClick={run} disabled={phase === "running"}>
              {phase === "running" ? "Running" : phase === "done" ? "Run again" : "Run both"}
            </button>
            <button className="btn" onClick={onClose}>Close</button>
          </div>
        </div>

        {phase === "running" && <div className="cmp-progress" data-testid="compare-progress">{step}</div>}

        {phase === "idle" && (
          <p className="cmp-explain muted">
            The baseline reads the rendered page and types into the controls it can find, which is all an agent
            without tools can do. The tool path calls the typed WebMCP tools. The interesting difference is not
            speed: it is what each one can know about the form.
          </p>
        )}

        {baseline && tools && (
          <>
            <div className="cmp-metrics" data-testid="compare-metrics" data-measured="1">
              <div className="cmp-metric-row cmp-metric-head">
                <span />
                <b>{baseline.label}</b>
                <b>{tools.label}</b>
              </div>
              <MetricRow label="Steps taken" a={String(baseline.steps)} b={String(tools.steps)} better="low" />
              <MetricRow label="Wall clock" a={`${(baseline.wallClockMs / 1000).toFixed(1)}s`} b={`${(tools.wallClockMs / 1000).toFixed(1)}s`} better="low" />
              <MetricRow label="Fields left missing" a={String(baseline.fieldsMissing)} b={String(tools.fieldsMissing)} better="low" />
              <MetricRow label="Fields filled but malformed" a={String(baseline.fieldsInvalid)} b={String(tools.fieldsInvalid)} better="low" />
              <MetricRow label="Clinician-only fields written to" a={String(baseline.judgmentFieldsTouched)} b={String(tools.judgmentFieldsTouched)} better="low" />
              <MetricRow label="Clinical conflicts surfaced" a={String(baseline.conflictsFound)} b={String(tools.conflictsFound)} better="high" />
              <MetricRow label="Outcome" a={baseline.outcome} b={tools.outcome} better="none" />
            </div>
            <p className="cmp-explain muted">
              The baseline is a plain implementation, not a strawman: it reads the patient panel and matches on
              label text. It still writes the diagnosis as prose where the payer wants an ICD-10 code, because
              nothing on the page says otherwise, and it types into clinician-judgment fields because it has no
              way to tell them apart. The schema is what removes both problems.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
