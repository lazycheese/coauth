import { useCoAuth } from "../store/coauthStore";
import { scriptedAgentActions } from "../app/actions";

const store = () => useCoAuth.getState();

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface DemoHandle {
  cancelled: boolean;
}

/** Autonomous run of the full human+agent narrative (denial scenario).
 * Lets the live URL demonstrate itself even without a real agent attached. */
export async function runDemo(setCaption: (c: string) => void, handle: DemoHandle) {
  const t = scriptedAgentActions;
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
  await step("The agent asks the site how to work - the page teaches it the rules.", () => t.guidance(), 1300);
  await step("A prior authorization comes in for Marcus Lee - Humira, Aetna.", () => t.loadPatient("marcus-lee"), 1100);
  await step("The agent reads the payer's rules as typed tools - no screen-scraping.", () => t.choosePayer("aetna"), 1100);

  const fills: [string, string][] = [
    ["member_id", "AET-55190"],
    ["prescriber_npi", "1487203941"],
    ["diagnosis_code", "L40.50"],
    ["hcpcs_code", "J0135"],
    ["dose", "40 mg SC every other week"],
    ["quantity", "2 syringes / 28 days"],
    ["step_therapy", "Methotrexate 1 month - ongoing"],
  ];
  setCaption("The agent fills every field from the record, typed and checked as it goes.");
  for (const [f, v] of fills) {
    if (handle.cancelled) throw new Error("cancelled");
    await t.fillField(f, v);
    await wait(340);
  }
  await t.attachEvidence("tb_screen", "doc-tb");
  await wait(700);

  await step("It scores denial risk live - this one is high.", () => t.assessRisk(), 1200);
  await step("Then it checks the record for clinical conflicts…", () => t.detectConflicts(), 1300);
  await step("The agent catches a positive TB screen, a contraindication a rushed clinician could miss.", () => {}, 1900);
  await step("It tries to submit - and is blocked. The agent cannot sign for a human.", () => t.submit(), 1800);

  await step("Now the clinician does what only a clinician can: record a medical override.", () => {
    store().resolveConflict("tb-contra", "Latent TB treated (INH ×9 mo, completed 2026-06); Infectious Disease cleared for biologic therapy.");
    store().logActivity("human", "override", "tb-contra: latent TB treated, ID cleared");
  }, 1600);

  await step("The agent drafts the medical-necessity language - grounded in the chart, not invented.", () => t.draftField("medical_necessity"), 1700);
  await step("The clinician reviews the draft and accepts it - staying accountable for the words.", () => store().acceptSuggestion("medical_necessity"), 1400);

  // The walkthrough stops here, and the stopping is the point.
  //
  // What remains is the attending attestation and the signature. Neither is
  // something this script can do: fill_field refuses clinician-judgment fields,
  // and an approval is minted only for an authenticated clinician session. An
  // earlier version of this walkthrough wrote the attestation itself and called
  // sign() with a made-up name, which demonstrated the opposite of what the
  // product claims.
  await step("The agent tries to submit. It cannot: no clinician has signed.", () => t.submit(), 1600);

  store().runValidation();
  await wait(600);

  setCaption(
    "This is as far as an agent goes. The attestation and the signature are the clinician's: sign in on the right to finish it."
  );
}
