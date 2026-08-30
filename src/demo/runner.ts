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

  await step("The agent drafts the medical-necessity language - grounded in the chart, not invented.", () => t.draftField("medical_necessity"), 1700);
  await step("It proposes the wording. It cannot adopt it: accepting a draft is the clinician's signature on those words.", () => {}, 1700);

  // The walkthrough stops here, and the stopping is the point.
  //
  // Three things remain and the script performs none of them: recording the
  // clinical override for the positive TB screen, accepting the drafted
  // wording, and signing. Each is guarded by the same rule - a real gesture
  // from a person - and a script that performed them here would be
  // demonstrating the opposite of what the product claims.
  //
  // An earlier version of this walkthrough did all three, and logged them as
  // the clinician's. It was the most convincing part of the demo and the least
  // true thing in the repository.
  await step("The agent tries to submit. It is blocked: an unresolved contraindication and no clinician signature.", () => t.submit(), 1600);

  store().runValidation();
  await wait(600);

  setCaption(
    "This is as far as an agent goes. The TB override, the drafted wording and the signature are the clinician's: sign in on the right to finish it."
  );
}
