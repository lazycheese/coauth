// Shared, runtime-agnostic handlers. Used by Vercel Edge functions (prod)
// and the Vite dev middleware (local), so /api behaves identically in both.
import { getPatient, getPayerRules, patients, payers } from "../src/data/seed";
import { validate } from "../src/rules/validate";

type Result = { status: number; body: unknown };

function err(status: number, code: string, message: string, hint: string): Result {
  return { status, body: { error: { code, message, hint } } };
}

export function patientResult(id: string): Result {
  const patient = getPatient(id);
  if (!patient) return err(404, "patient_not_found", `No patient with id "${id}".`, `Valid ids: ${Object.keys(patients).join(", ")}.`);
  return { status: 200, body: patient };
}

export function payerRulesResult(payer: string): Result {
  const rules = getPayerRules(payer);
  if (!rules) return err(404, "payer_not_found", `No payer with id "${payer}".`, `Valid payers: ${Object.keys(payers).join(", ")}.`);
  return { status: 200, body: rules };
}

export function validateResult(payer: string, formFields: Record<string, unknown>): Result {
  const rules = getPayerRules(payer) ?? null;
  if (!rules) return err(400, "invalid_payer", `Unknown payer "${payer}".`, `Send { payer, formFields } with payer one of: ${Object.keys(payers).join(", ")}.`);
  return { status: 200, body: validate(formFields, rules) };
}
