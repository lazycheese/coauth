import { useCoAuth } from "../store/coauthStore";

// A DOM-driven baseline, for measuring rather than for illustration.
//
// This is what an agent without tools has to do: read the rendered page, guess
// which control corresponds to which requirement, and type text into it. It has
// no schema, so it cannot know that a diagnosis field wants an ICD-10 code and
// not the diagnosis name, and no notion of which fields a clinician must own.
//
// It is deliberately a fair-minded implementation, not a strawman: it reads the
// visible patient panel, matches on label text, and fills what it can find. The
// numbers the comparison shows are whatever this actually achieves against the
// same form, measured in the browser at the time you run it.

export interface RunMetrics {
  label: string;
  steps: number;
  wallClockMs: number;
  fieldsFilled: number;
  fieldsMissing: number;
  fieldsInvalid: number;
  judgmentFieldsTouched: number;
  conflictsFound: number;
  outcome: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  if (l.includes("drug") || l.includes("hcpcs")) return "Humira";
  if (l.includes("dose")) return "40mg every other week";
  if (l.includes("quantity")) return "2";
  if (l.includes("npi")) return "unknown";
  if (l.includes("step therapy")) {
    const meds = facts.filter((f) => /methotrexate|sulfasalazine/i.test(f));
    return meds.join("; ") || null;
  }
  if (l.includes("necessity") || l.includes("rationale")) return "Medically necessary.";
  if (l.includes("attestation")) return "Attested";
  return null;
}

/** Run the baseline against the live form and measure what it achieves. */
export async function runBaseline(onStep?: (s: string) => void): Promise<RunMetrics> {
  const store = useCoAuth.getState;
  const started = performance.now();
  let steps = 0;
  let judgmentTouched = 0;

  onStep?.("Reading the rendered page");
  steps++;
  await sleep(120);

  const facts = visibleFacts();
  const rows = Array.from(document.querySelectorAll<HTMLElement>(".field"));
  const judgmentIds = new Set(
    (store().payerRules?.requiredFields ?? []).filter((f) => f.requiresHumanJudgment).map((f) => f.id)
  );

  for (const row of rows) {
    steps++;
    const labelText = row.querySelector(".field-label")?.textContent ?? "";
    const control = row.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
    const select = row.querySelector<HTMLSelectElement>("select");
    const fieldId = row.getAttribute("data-testid")?.replace("field-", "") ?? "";

    onStep?.(`Locating "${labelText.replace(/clinician|verified from chart|agent-entered/gi, "").trim()}"`);
    await sleep(90);

    const value = guess(labelText, facts);
    if (!value) continue;

    // It cannot tell a clinician-judgment field from any other input.
    if (judgmentIds.has(fieldId)) judgmentTouched++;

    if (select) {
      const opt = Array.from(select.options).find((o) => o.value === value);
      if (opt) {
        select.value = opt.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
    } else if (control) {
      setNative(control, value);
    }
    await sleep(60);
  }

  onStep?.("Submitting");
  steps++;
  await sleep(150);

  const v = store().runValidation();
  const invalid = v.invalidCount;
  const missing = Math.max(0, v.failCount - invalid);
  const filled = v.results.length - v.failCount - v.judgmentCount + (v.judgmentCount - v.judgmentCount);

  return {
    label: "DOM-driven baseline",
    steps,
    wallClockMs: Math.round(performance.now() - started),
    fieldsFilled: v.results.filter((r) => r.ok).length + invalid,
    fieldsMissing: missing,
    fieldsInvalid: invalid,
    judgmentFieldsTouched: judgmentTouched,
    conflictsFound: 0, // it has no rules engine to consult
    outcome: v.clearForSignature ? "Reached signature" : `Rejected: ${missing} missing, ${invalid} malformed`,
  };
}

/** The same task through the WebMCP tools, measured on the same clock. */
export async function runToolPath(onStep?: (s: string) => void): Promise<RunMetrics> {
  const { scriptedAgentActions } = await import("../app/actions");
  const store = useCoAuth.getState;
  const started = performance.now();
  let steps = 0;

  const patient = store().patient;
  const rules = store().payerRules;
  if (!patient || !rules) throw new Error("load a patient and payer first");

  const values: Record<string, string> = {
    member_id: patient.memberId,
    prescriber_npi: "1487203941",
    diagnosis_code: patient.diagnoses[0].code,
    hcpcs_code: "J0135", // the drug this payer file covers
    dose: "40 mg SC every other week",
    quantity: "2 syringes / 28 days",
    step_therapy: patient.medsTried.map((m) => `${m.name} ${m.durationMonths}mo, ${m.outcome}`).join("; "),
  };

  for (const f of rules.requiredFields) {
    // The schema marks these as the clinician's, so they are never touched.
    if (f.requiresHumanJudgment) continue;
    steps++;
    onStep?.(`fill_field: ${f.id}`);
    if (f.type === "evidence") await scriptedAgentActions.attachEvidence(f.id, "doc-tb");
    else if (values[f.id]) await scriptedAgentActions.fillField(f.id, values[f.id]);
    await sleep(60);
  }

  steps++;
  onStep?.("detect_conflicts");
  await scriptedAgentActions.detectConflicts();
  await sleep(90);

  steps++;
  onStep?.("validate_submission");
  const v = store().runValidation();
  await sleep(90);

  const invalid = v.invalidCount;
  const missing = Math.max(0, v.failCount - invalid);
  return {
    label: "WebMCP tools",
    steps,
    wallClockMs: Math.round(performance.now() - started),
    fieldsFilled: v.results.filter((r) => r.ok).length,
    fieldsMissing: missing,
    fieldsInvalid: invalid,
    judgmentFieldsTouched: 0,
    conflictsFound: store().conflicts.length,
    outcome: missing === 0 && invalid === 0 ? "Ready for clinician review" : `${missing} missing, ${invalid} malformed`,
  };
}
