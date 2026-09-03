// X12 278 mapping — the EDI transaction real prior authorization runs on.
//
// A prior authorization is not filed as JSON. Payers exchange it as an X12 278
// "Health Care Services Review - Request for Review", the HIPAA-mandated
// transaction set for authorization. This maps a completed CoAuth submission to
// that transaction so the demo is honest about the last mile: the same fields
// the agent filled and the clinician signed become the segments a clearinghouse
// would actually transmit.
//
// This is a faithful structural rendering, not a certified X12 encoder — it
// produces the loops and segments (BHT, HL hierarchy, NM1/UM/HCR/HI) a 278
// carries, so a reader can see exactly where each captured value lands. A
// production integration would hand this shape to an EDI library that adds the
// ISA/GS envelope, control numbers and payer-specific companion-guide rules.

import type { Patient, PayerRules } from "../data/seed";
import { getDrug } from "../data/seed";

export interface X12Submission {
  payer: PayerRules;
  patient: Patient;
  formFields: Record<string, unknown>;
  confirmationId: string;
  npi: string;
  signer: string;
}

const seg = (...els: (string | number | undefined)[]) =>
  els.map((e) => (e === undefined || e === null ? "" : String(e))).join("*").replace(/\*+$/, "") + "~";

const str = (v: unknown) => (v == null ? "" : String(v).trim());

/** Map a completed submission to an X12 278 transaction set (ST…SE). */
export function toX12_278(s: X12Submission): string {
  const { payer, patient, formFields, confirmationId, npi, signer } = s;
  const dx = str(formFields["diagnosis_code"]) || patient.diagnoses[0]?.code || "";
  const hcpcs = str(formFields["hcpcs_code"]);
  const drug = getDrug(hcpcs);
  const member = str(formFields["member_id"]) || patient.memberId;
  const [lastName, ...rest] = patient.name.split(" ").reverse();
  const firstName = rest.reverse().join(" ");
  const dob = patient.dob.replace(/-/g, "");
  const ctrl = confirmationId.replace(/[^0-9A-Z]/gi, "").slice(0, 9) || "0001";

  const lines: string[] = [];
  // Transaction set header — 278 request (13), version 005010X217.
  lines.push(seg("ST", "278", "0001", "005010X217"));
  lines.push(seg("BHT", "0007", "13", ctrl, "", "", "RU")); // RU = medical services reservation

  // 2000A - Utilization Management Organization (the payer)
  lines.push(seg("HL", "1", "", "20", "1"));
  lines.push(seg("NM1", "X3", "2", payer.name, "", "", "", "", "PI", payer.id.toUpperCase()));

  // 2000B - Requester (the prescribing clinician)
  lines.push(seg("HL", "2", "1", "21", "1"));
  lines.push(seg("NM1", "1P", "1", signer, "", "", "", "", "XX", npi));

  // 2000C - Subscriber / patient
  lines.push(seg("HL", "3", "2", "22", "0"));
  lines.push(seg("NM1", "IL", "1", lastName, firstName, "", "", "", "MI", member));
  lines.push(seg("DMG", "D8", dob));

  // 2000E - Service (the requested drug), with the review outcome
  lines.push(seg("HL", "4", "3", "SS", "0"));
  lines.push(seg("UM", "HS", "I", "", "", "", "", "Y")); // HS = health services review, I = initial
  lines.push(seg("HCR", "A4", confirmationId)); // A4 = pended/authorized reference, carries the confirmation id
  if (dx) lines.push(seg("HI", `ABK:${dx.replace(".", "")}`)); // principal diagnosis, ICD-10-CM
  if (hcpcs) lines.push(seg("SV1", `HC:${hcpcs}`, "", "UN", "1")); // requested service, HCPCS
  if (drug) lines.push(seg("REF", "XZ", drug.name)); // human-readable drug name for the reader

  lines.push(seg("SE", String(lines.length + 1), "0001"));
  return lines.join("\n");
}
