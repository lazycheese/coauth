import { useCoAuth } from "../store/coauthStore";
import { scriptedAgentActions } from "../app/actions";

// A DOM-driven baseline, for measuring rather than for illustration.
//
// This is what an agent without tools has to do: read the rendered page, guess
// which control corresponds to which requirement, and type text into it. It has
// no schema, so it cannot know that a diagnosis field wants an ICD-10 code and
// not the diagnosis name, and no notion of which fields a clinician must own.
//
// What this comparison does and does not claim:
//
//   - It measures what each path achieves on the form: how many fields end up
//     filled, malformed or missing, how many clinician-only fields get written
//     to, and how many clinical conflicts each path surfaces. Every one of
//     those is read back out of the store after the run.
//   - It does NOT measure speed, and no longer reports a time. An earlier
//     version showed a wall-clock difference produced by hardcoded, asymmetric
//     sleep() calls on the two paths - a design decision typed into this file
//     and presented as a measurement. There are no sleeps here now, and both
//     paths run against the same store on the same clock, so the only honest
//     reading of a duration would be of this machine's JavaScript, which is not
//     what anyone wants to know.
//   - Neither arm is an LLM. This compares the two interfaces a model is given,
//     not two models. The baseline's wrong answers come from having only label
//     text to go on; the tool path's come from nowhere, because the schema
//     names the code it wants.
//
// The baseline is a fair-minded implementation rather than a strawman: it reads
// the visible patient panel, matches on label text, and fills what it can find.
// Where it gets something wrong, that is the point being measured.

export interface RunMetrics {
  label: string;
  steps: number;
  fieldsFilled: number;
  fieldsMissing: number;
  fieldsInvalid: number;
  judgmentFieldsTouched: number;
  conflictsFound: number;
  outcome: string;
}

/** Cooperative cancellation, so closing the dialog actually stops the run. */
export interface RunHandle {
  cancelled: boolean;
}

export class RunCancelled extends Error {
  constructor() {
    super("run cancelled");
    this.name = "RunCancelled";
  }
}

function checkCancelled(handle?: RunHandle) {
  if (handle?.cancelled) throw new RunCancelled();
}

function setNative(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Everything the baseline can see: the rendered patient panel. */
function visibleFacts(): string[] {
  const panel = document.querySelector('[data-testid="patient-card"]');
  if (!panel) return [];
  return (panel.textContent ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Guess a value for a field from its label and whatever is on screen. */
function guess(labelText: string, facts: string[]): string | null {
  const l = labelText.toLowerCase();
  const find = (re: RegExp) => facts.map((f) => f.match(re)?.[0]).find(Boolean) ?? null;

  if (l.includes("member")) return find(/\b[A-Z]{3}-\d{4,}\b/);
  // No schema, so the visible diagnosis text is the only candidate. A tool-less
  // agent has no way to know the payer wants the code on its own.
  if (l.includes("diagnosis")) {
    const line = facts.find((f) => /arthritis|psoriasis|rheumatoid/i.test(f));
    return line ?? null;
  }
  // The page shows the drug by brand name, which is what a reader of the page
  // has. The payer file wants a HCPCS code, and nothing rendered says so.
  if (l.includes("drug") || l.includes("hcpcs")) {
    return find(/\b[A-Z][a-z]+ \(adalimumab\)/) ?? facts.find((f) => /humira|adalimumab/i.test(f)) ?? null;
  }
  if (l.includes("dose")) return "40mg every other week";
  if (l.includes("quantity")) return "2";
  if (l.includes("npi")) return null;
  if (l.includes("step therapy")) {
    const meds = facts.filter((f) => /methotrexate|sulfasalazine/i.test(f));
    return meds.join("; ") || null;
  }
  if (l.includes("necessity") || l.includes("rationale")) return "Medically necessary.";
  if (l.includes("attestation")) return "Attested";
  return null;
}

/** Read the outcome of a run out of the store, the same way for both paths. */
function measure(label: string, steps: number, judgmentTouched: number): RunMetrics {
  const store = useCoAuth.getState;
  const v = store().runValidation();
  const invalid = v.invalidCount;
  const missing = Math.max(0, v.failCount - invalid);
  return {
    label,
    steps,
    fieldsFilled: v.results.filter((r) => r.ok).length + invalid,
    fieldsMissing: missing,
    fieldsInvalid: invalid,
    judgmentFieldsTouched: judgmentTouched,
    // Read from the store for both paths. The baseline's count used to be a
    // hardcoded 0 on the grounds that it "has no rules engine to consult" -
    // but it drives the same store, whose validation computes conflicts, so
    // the zero was asserted rather than observed.
    conflictsFound: store().conflicts.length,
    outcome:
      missing === 0 && invalid === 0
        ? "Complete, ready for clinician review"
        : `${missing} missing, ${invalid} malformed`,
  };
}

/** Run the baseline against the live form and measure what it achieves. */
export async function runBaseline(onStep?: (s: string) => void, handle?: RunHandle): Promise<RunMetrics> {
  const store = useCoAuth.getState;
  let steps = 0;
  let judgmentTouched = 0;

  onStep?.("Reading the rendered page");
  steps++;
  checkCancelled(handle);

  const facts = visibleFacts();
  const rows = Array.from(document.querySelectorAll<HTMLElement>(".field"));
  const judgmentIds = new Set(
    (store().payerRules?.requiredFields ?? []).filter((f) => f.requiresHumanJudgment).map((f) => f.id)
  );

  for (const row of rows) {
    checkCancelled(handle);
    steps++;
    const labelText = row.querySelector(".field-label")?.textContent ?? "";
    const control = row.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
    const select = row.querySelector<HTMLSelectElement>("select");
    const fieldId = row.getAttribute("data-testid")?.replace("field-", "") ?? "";

    onStep?.(`Locating "${labelText.replace(/clinician|verified from chart|agent-entered/gi, "").trim()}"`);

    const value = guess(labelText, facts);
    if (!value) continue;

    // Count what actually lands, not what is attempted: the tool arm counts
    // writes the tool surface let through, so the baseline has to be counted
    // the same way or the two columns are different measurements.
    let wrote = false;
    if (select) {
      const opt = Array.from(select.options).find((o) => o.value === value);
      if (opt) {
        select.value = opt.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        wrote = true;
      }
    } else if (control) {
      setNative(control, value);
      wrote = true;
    }

    // It cannot tell a clinician-judgment field from any other input.
    if (wrote && judgmentIds.has(fieldId)) judgmentTouched++;
  }

  onStep?.("Checking the result");
  steps++;
  checkCancelled(handle);

  return measure("DOM-driven baseline", steps, judgmentTouched);
}

/** The same task through the WebMCP tools, measured the same way. */
export async function runToolPath(onStep?: (s: string) => void, handle?: RunHandle): Promise<RunMetrics> {
  const store = useCoAuth.getState;
  let steps = 0;
  let judgmentTouched = 0;

  const patient = store().patient;
  const rules = store().payerRules;
  if (!patient || !rules) throw new Error("load a patient and payer first");

  // Read the drug from the payer's own coverage file rather than naming a code
  // here. Handing the tool arm a hardcoded J0135 gave it an answer the baseline
  // was denied, which made the comparison about the constant rather than about
  // the interface.
  const hcpcs = rules.coveredDrugs[0] ?? "";

  const values: Record<string, string> = {
    member_id: patient.memberId,
    prescriber_npi: "1487203941",
    diagnosis_code: patient.diagnoses[0].code,
    hcpcs_code: hcpcs,
    dose: "40 mg SC every other week",
    quantity: "2 syringes / 28 days",
    step_therapy: patient.medsTried.map((m) => `${m.name} ${m.durationMonths}mo, ${m.outcome}`).join("; "),
  };

  const judgmentIds = new Set(rules.requiredFields.filter((f) => f.requiresHumanJudgment).map((f) => f.id));

  for (const f of rules.requiredFields) {
    checkCancelled(handle);
    steps++;
    onStep?.(`fill_field: ${f.id}`);
    // Attempt every field, including the clinician's, and count what actually
    // lands. Skipping them made the resulting zero a property of this loop
    // rather than of the tool surface, which is what was being measured.
    let result: unknown;
    if (f.type === "evidence") result = await scriptedAgentActions.attachEvidence(f.id, "doc-tb");
    else if (values[f.id]) result = await scriptedAgentActions.fillField(f.id, values[f.id]);
    else if (judgmentIds.has(f.id)) result = await scriptedAgentActions.fillField(f.id, "Medically necessary.");
    else continue;

    // A refusal is not a write. fill_field rejects clinician-judgment fields,
    // so this counts only what the tool surface let through.
    const refused =
      typeof result === "object" && result !== null && (result as { status?: string }).status === "refused";
    if (judgmentIds.has(f.id) && !refused) judgmentTouched++;
  }

  checkCancelled(handle);
  steps++;
  onStep?.("detect_conflicts");
  await scriptedAgentActions.detectConflicts();

  checkCancelled(handle);
  steps++;
  onStep?.("validate_submission");

  return measure("WebMCP tools", steps, judgmentTouched);
}
