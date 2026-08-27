import { useCoAuth } from "../store/coauthStore";

type Tools = Record<string, (input?: any) => Promise<any> | any>;
const tools = (): Tools => (window as any).__coauth.tools;
const store = () => useCoAuth.getState();

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface DemoHandle {
  cancelled: boolean;
}

/** Autonomous run of the full human+agent narrative (denial scenario).
 * Lets the live URL demonstrate itself even without a real agent attached. */
export async function runDemo(setCaption: (c: string) => void, handle: DemoHandle) {
  const t = tools();
  const step = async (caption: string, fn: () => Promise<any> | any, pause = 900) => {
    if (handle.cancelled) throw new Error("cancelled");
    setCaption(caption);
    await fn();
    await wait(pause);
  };

  store().reset();
  await wait(500);

  setCaption("Scripted walkthrough - a canned replay of the human + agent flow (not a live agent).");
  await wait(1600);
  await step("The agent asks the site how to work - the page teaches it the rules.", () => t.get_workflow_guidance(), 1300);
  await step("A prior authorization comes in for Marcus Lee - Humira, Aetna.", () => t.load_patient_context({ patientId: "marcus-lee" }), 1100);
  await step("The agent reads the payer's rules as typed tools - no screen-scraping.", () => t.check_payer_rules({ payer: "aetna" }), 1100);

  const fills: [string, string][] = [
    ["member_id", "AET-55190"],
    ["prescriber_npi", "1487203941"],
    ["diagnosis_code", "L40.50"],
    ["hcpcs_code", "J0135"],
    ["dose", "40 mg SC every other week"],
    ["quantity", "2 syringes / 28 days"],
    ["step_therapy", "Methotrexate 1 month - ongoing"],
  ];
  setCaption("The agent fills every field at machine speed - structured, no guessing.");
  for (const [f, v] of fills) {
    if (handle.cancelled) throw new Error("cancelled");
    await t.fill_field({ fieldId: f, value: v });
    await wait(340);
  }
  await t.attach_evidence({ fieldId: "tb_screen", docId: "doc-tb" });
  await wait(700);

  await step("It scores denial risk live - this one is high.", () => t.assess_denial_risk({}), 1200);
  await step("Then it checks the record for clinical conflicts…", () => t.detect_conflicts({}), 1300);
  await step("The agent catches a positive TB screen, a contraindication a rushed clinician could miss.", () => {}, 1900);
  await step("It tries to submit - and is blocked. The agent cannot sign for a human.", () => t.submit(), 1800);

  await step("Now the clinician does what only a clinician can: record a medical override.", () => {
    store().resolveConflict("tb-contra", "Latent TB treated (INH ×9 mo, completed 2026-06); Infectious Disease cleared for biologic therapy.");
    store().logActivity("human", "override", "tb-contra: latent TB treated, ID cleared");
  }, 1600);

  await step("The agent drafts the medical-necessity language - grounded in the chart, not invented.", () => t.draft_field({ fieldId: "medical_necessity" }), 1700);
  await step("The clinician reviews the draft and accepts it - staying accountable for the words.", () => store().acceptSuggestion("medical_necessity"), 1400);
  store().setField("attending_attestation", "Attested");
  store().runValidation();
  await wait(900);

  await step("Risk drops. Requirements met. The clinician signs & attests.", async () => {
    await store().sign("I attest this prior authorization is clinically accurate.", "Dr. A. Reyes, MD (demo)");
    store().logActivity("human", "sign", "Clinician signed & attested");
  }, 1400);

  await step("Only now does submit succeed - human-signed, conflict-checked, audit-logged.", () => t.submit(), 1400);

  setCaption("Human + agent, on the same page: the agent's speed, the clinician's judgment.");
}
