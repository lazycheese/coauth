import { useEffect, useRef, useState } from "react";
import { useCoAuth } from "../store/coauthStore";
import { humanActions } from "../app/actions";
import { runBaseline, runToolPath, RunCancelled, type RunHandle, type RunMetrics } from "../demo/baseline";
import { Dialog } from "./Dialog";
import { beginScriptedRun, endScriptedRun } from "../app/scriptedRun";

type Phase = "idle" | "running" | "done";

function MetricRow({ label, a, b, better }: { label: string; a: string; b: string; better: "low" | "high" | "none" }) {
  // "better" only drives colour; the values themselves are measured. The
  // data-side labels carry the column meaning on narrow screens, where the
  // header row is hidden.
  return (
    <div className="cmp-metric-row">
      <span className="cmp-metric-label">{label}</span>
      <b className={better === "none" ? "" : "bad"} data-side="Baseline">{a}</b>
      <b className={better === "none" ? "" : "good"} data-side="Tools">{b}</b>
    </div>
  );
}

export function Compare({ onClose }: { onClose: () => void }) {
  const reset = useCoAuth((s) => s.reset);
  const [phase, setPhase] = useState<Phase>("idle");
  const [step, setStep] = useState<string>("");
  const [baseline, setBaseline] = useState<RunMetrics | null>(null);
  const [tools, setTools] = useState<RunMetrics | null>(null);

  // The handle is threaded all the way into both runners' loops, so cancelling
  // actually stops the work rather than only stopping the phase transitions
  // between the two runs.
  const handleRef = useRef<RunHandle | null>(null);

  // Closing the dialog mid-run has to stop the run. Without this the runners
  // kept driving the store after the component that started them was gone.
  useEffect(() => () => {
    if (handleRef.current) handleRef.current.cancelled = true;
  }, []);

  const run = async () => {
    // Measuring requires sole control of the workspace, so this stops the
    // walkthrough if it happens to be mid-flight.
    const handle: RunHandle = { cancelled: false };
    handleRef.current = handle;
    beginScriptedRun("comparison", () => {
      handle.cancelled = true;
      setPhase("idle");
      setStep("");
    });

    setPhase("running");
    setBaseline(null);
    setTools(null);

    // Same patient, same payer, same form, one run each.
    const setup = async () => {
      reset();
      await humanActions.loadPatient("marcus-lee");
      await humanActions.choosePayer("aetna");
    };

    try {
      await setup();
      setStep("Running the DOM-driven baseline");
      const b = await runBaseline((s) => setStep(`Baseline: ${s}`), handle);
      setBaseline(b);

      await setup();
      setStep("Running the same task through the tools");
      const t = await runToolPath((s) => setStep(`Tools: ${s}`), handle);
      setTools(t);

      setStep("");
      setPhase("done");
    } catch (e) {
      if (!(e instanceof RunCancelled)) throw e;
      setPhase("idle");
      setStep("");
    } finally {
      endScriptedRun("comparison");
      if (handleRef.current === handle) handleRef.current = null;
    }
  };

  return (
    <Dialog title="Same form, with and without tools" testId="compare-overlay" className="cmp-modal" onClose={onClose}>
      <>
        <div className="cmp-head">
          <div>
            <h2>Same form, with and without tools</h2>
            <p className="muted">
              Both runs happen in this browser when you press the button, against the same patient and payer.
              Every number below is read back out of the form after the run. There is no timing here: speed is not
              what separates the two, and a stopwatch on two scripts would only measure the scripts.
            </p>
          </div>
          <div className="cmp-actions">
            <button className="btn btn-primary" data-testid="compare-run" onClick={run} disabled={phase === "running"}>
              {phase === "running" ? "Running" : phase === "done" ? "Run again" : "Run both"}
            </button>
            <button className="btn" onClick={onClose}>Close</button>
          </div>
        </div>

        {phase === "running" && <div className="cmp-progress" role="status" aria-live="polite" data-testid="compare-progress">{step}</div>}

        {phase === "idle" && (
          <p className="cmp-explain muted">
            The baseline reads the rendered page and types into the controls it can find, which is all an agent
            without tools can do. The tool path calls the typed WebMCP tools, and attempts every field including
            the clinician's. The difference is not speed: it is what each one can know about the form, and what
            each one is allowed to write.
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
              <MetricRow label="Fields left missing" a={String(baseline.fieldsMissing)} b={String(tools.fieldsMissing)} better="low" />
              <MetricRow label="Fields filled but malformed" a={String(baseline.fieldsInvalid)} b={String(tools.fieldsInvalid)} better="low" />
              <MetricRow label="Clinician-only fields written to" a={String(baseline.judgmentFieldsTouched)} b={String(tools.judgmentFieldsTouched)} better="low" />
              <MetricRow label="Clinical conflicts surfaced" a={String(baseline.conflictsFound)} b={String(tools.conflictsFound)} better="high" />
              <MetricRow label="Outcome" a={baseline.outcome} b={tools.outcome} better="none" />
            </div>
            <p className="cmp-explain muted">
              The baseline is a plain implementation, not a strawman: it reads the patient panel and matches on
              label text. It writes the diagnosis as prose where the payer wants an ICD-10 code, and the drug by
              brand name where the payer wants a HCPCS code, because nothing on the page says otherwise. It types
              into clinician-judgment fields because it has no way to tell them apart; the tool path attempts the
              same fields and is refused by the tool. Neither arm is a language model, so this compares two
              interfaces rather than two models.
            </p>
          </>
        )}
      </>
    </Dialog>
  );
}
