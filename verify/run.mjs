#!/usr/bin/env node
// Live verification for CoAuth.
//
// These are not unit tests. Nothing here stubs, mocks or reaches inside the
// application: every check drives the running product, either over HTTP or by
// clicking through a real browser. That is deliberate, because the claims worth
// checking are claims about the deployed system, and a passing unit test of a
// signature helper would not tell you whether the deployed gate holds.
//
//   npm run verify                      against a local dev server
//   npm run verify -- --url <origin>    against a deployment
//
// Browser checks are skipped with a clear note if Playwright is unavailable, so
// the HTTP checks still run anywhere.

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const BASE = (arg("url", process.env.VERIFY_URL || "http://localhost:5173")).replace(/\/$/, "");
const DEPLOYED = !BASE.includes("localhost") && !BASE.includes("127.0.0.1");

let pass = 0, fail = 0, skip = 0;
const failures = [];

function ok(name, detail = "") {
  pass++;
  console.log(`  PASS  ${name}${detail ? `  (${detail})` : ""}`);
}
function bad(name, expected, actual) {
  fail++;
  failures.push({ name, expected, actual });
  console.log(`  FAIL  ${name}\n        expected: ${expected}\n        actual:   ${actual}`);
}
function skipped(name, why) {
  skip++;
  console.log(`  SKIP  ${name}  (${why})`);
}
function check(name, actual, expected) {
  const a = typeof actual === "object" ? JSON.stringify(actual) : String(actual);
  const e = typeof expected === "object" ? JSON.stringify(expected) : String(expected);
  a === e ? ok(name, a) : bad(name, e, a);
}
function section(title) {
  console.log(`\n${title}`);
}

const post = async (path, body, headers = {}) => {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* some responses carry no body */ }
  return { status: res.status, headers: res.headers, json };
};

// ---------------------------------------------------------------------------
// The clinician approval gate. The claim is that an agent cannot submit on a
// human's behalf, so each of these is an attempt to do exactly that.
// ---------------------------------------------------------------------------
async function verifyApprovalGate() {
  section("Clinician approval gate");

  const form = { member_id: "UHC-88213", dose: "40 mg SC every other week" };
  const signed = await post("/api/v1/sign", {
    payer: "uhc", formFields: form, attestation: "I attest.", signer: "Verification Script",
  });

  if (signed.status === 503) {
    skipped("approval gate", "no signing secret configured on this deployment");
    return;
  }
  check("a signed approval is issued", signed.status, 200);
  const token = signed.json?.token;
  if (!token) { bad("token minted", "a token", "none"); return; }

  const honest = await post("/api/v1/submit", { payer: "uhc", formFields: form, token });
  check("an honest submission is accepted", honest.json?.status, "submitted");

  const replay = await post("/api/v1/submit", { payer: "uhc", formFields: form, token });
  check("the same approval cannot be used twice", replay.json?.error?.code, "approval_already_used");

  const fresh = (await post("/api/v1/sign", {
    payer: "uhc", formFields: form, attestation: "I attest.", signer: "Verification Script",
  })).json.token;

  const unsigned = await post("/api/v1/submit", { payer: "uhc", formFields: form });
  check("an unsigned submission is refused", unsigned.json?.error?.code, "approval_required");

  const forged = await post("/api/v1/submit", {
    payer: "uhc", formFields: form, token: { ...fresh, signer: "Somebody Else", mac: "0".repeat(64) },
  });
  check("a forged approval is refused", forged.json?.error?.code, "invalid_signature");

  const tampered = await post("/api/v1/submit", {
    payer: "uhc", formFields: { ...form, dose: "800 mg daily" }, token: fresh,
  });
  check("editing the form after signing invalidates it", tampered.json?.error?.code, "form_modified");

  const crossPayer = await post("/api/v1/submit", { payer: "aetna", formFields: form, token: fresh });
  check("an approval cannot be replayed at another payer", crossPayer.json?.error?.code, "payer_mismatch");
}

// ---------------------------------------------------------------------------
// MCP transport conformance (spec 2025-06-18).
// ---------------------------------------------------------------------------
async function verifyMcp() {
  section("MCP server, Streamable HTTP conformance");
  const path = "/.well-known/mcp";

  const get = await fetch(BASE + path, { headers: { accept: "text/event-stream" } });
  check("GET is 405 when no server stream is offered", get.status, 405);
  check("GET advertises the allowed method", get.headers.get("allow"), "POST");

  const badVersion = await post(path, { jsonrpc: "2.0", id: 1, method: "ping" }, { "mcp-protocol-version": "1999-01-01" });
  check("an unsupported protocol version is rejected", badVersion.status, 400);

  const batch = await fetch(BASE + path, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]),
  });
  check("batched requests are refused", batch.status, 400);

  const notify = await post(path, { jsonrpc: "2.0", method: "notifications/initialized" });
  check("a notification is accepted with no body", notify.status, 202);

  const foreign = await post(path, { jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "https://evil.example" });
  check("a foreign origin is rejected", foreign.status, 403);

  const init = await post(path, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify", version: "1" } },
  });
  check("the handshake negotiates the requested version", init.json?.result?.protocolVersion, "2025-06-18");

  const call = await post(path, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "get_patient", arguments: { id: "nobody" } },
  }, { "mcp-protocol-version": "2025-06-18" });
  check("a failing tool reports through the result, not a protocol error", call.json?.result?.isError, true);

  const unknown = await post(path, {
    jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "no_such_tool" },
  }, { "mcp-protocol-version": "2025-06-18" });
  check("an unknown tool is a protocol error", unknown.json?.error?.code, -32602);
}

// ---------------------------------------------------------------------------
// HTTP security posture. Set by the platform, so only meaningful on a
// deployment.
// ---------------------------------------------------------------------------
async function verifyHeaders() {
  section("HTTP security headers");
  if (!DEPLOYED) {
    skipped("security headers", "set by the host, so only present on a deployment");
    return;
  }
  const res = await fetch(BASE + "/");
  const csp = res.headers.get("content-security-policy") ?? "";
  csp.includes("frame-ancestors 'none'")
    ? ok("the approval UI cannot be framed", "frame-ancestors 'none'")
    : bad("the approval UI cannot be framed", "frame-ancestors 'none'", csp || "no CSP");
  check("X-Frame-Options is set for older clients", res.headers.get("x-frame-options"), "DENY");
  check("content sniffing is disabled", res.headers.get("x-content-type-options"), "nosniff");
  const pp = res.headers.get("permissions-policy") ?? "";
  pp.includes("tools=(self)")
    ? ok("the WebMCP tools policy is pinned to this origin")
    : bad("the WebMCP tools policy is pinned", "tools=(self)", pp || "not set");
  (res.headers.get("strict-transport-security") ?? "").includes("max-age=")
    ? ok("HSTS is enabled")
    : bad("HSTS is enabled", "max-age=...", "not set");

  const api = await fetch(BASE + "/api/v1/patient/jane-doe");
  api.headers.get("ratelimit-limit")
    ? bad("no rate limit is advertised that is not enforced", "no RateLimit header", api.headers.get("ratelimit-limit"))
    : ok("no unenforced rate limit is advertised");
}

// ---------------------------------------------------------------------------
// Browser checks: the product itself, driven by clicking.
// ---------------------------------------------------------------------------
async function verifyInBrowser() {
  section("The running application");

  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    skipped("browser checks", "playwright is not installed; run npm i to include it");
    return;
  }

  let browser;
  try {
    browser = await chromium.launch();
  } catch (e) {
    skipped("browser checks", `a browser could not be launched (${e.message.split("\n")[0]})`);
    return;
  }

  const page = await browser.newPage();
  try {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".app-shell", { timeout: 15000 });

    if (DEPLOYED) {
      const exposed = await page.evaluate(() => typeof window.__coauth);
      check("no inspection handle is shipped to production", exposed, "undefined");
    } else {
      skipped("no inspection handle in production", "the dev build exposes one on purpose");
    }

    // The whole human-and-agent flow, started the way a person starts it.
    await page.click('[data-testid=intro-watch]');
    await page.waitForSelector("[data-testid=submitted-banner]", { timeout: 90000 });
    ok("the walkthrough completes and reaches a submission");

    const audit = await page.textContent("[data-testid=audit-log]");
    audit?.includes("verified by the server")
      ? ok("the audit trail records a server-verified signature")
      : bad("the audit trail records a server-verified signature", "verified by the server", audit?.trim() ?? "no audit trail");

    // Record content that reads as an instruction is flagged to the clinician.
    const flag = await page.textContent("[data-testid=doc-flag-doc-outside]").catch(() => null);
    flag
      ? ok("a document containing instruction-like text is flagged", flag.trim())
      : bad("a document containing instruction-like text is flagged", "a visible marker", "none");

    // Both sides of the comparison are measured, not asserted.
    await page.click("[data-testid=open-compare]");
    await page.click("[data-testid=compare-run]");
    await page.waitForSelector("[data-testid=compare-metrics]", { timeout: 90000 });
    const measured = await page.getAttribute("[data-testid=compare-metrics]", "data-measured");
    check("the comparison figures come from a live run", measured, "1");

    const rows = await page.$$eval(".cmp-metric-row", (els) =>
      els.map((e) => [...e.children].map((c) => c.textContent?.trim()).join(" | "))
    );
    const judgmentRow = rows.find((r) => r.startsWith("Clinician-only fields written to"));
    judgmentRow && /\|\s*0\s*$/.test(judgmentRow)
      ? ok("the tool path never writes to a clinician-only field", judgmentRow)
      : bad("the tool path never writes to a clinician-only field", "trailing 0", judgmentRow ?? "row missing");

    // A reviewer without a WebMCP agent must still be able to start.
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".app-shell", { timeout: 15000 });
    await page.click("[data-testid=intro-close]");
    const starters = await page.$$eval(".starter", (els) => els.length);
    starters > 0
      ? ok("someone without an agent has somewhere to start", `${starters} cases offered`)
      : bad("someone without an agent has somewhere to start", "at least one case", "none");
    await page.click("[data-testid=start-marcus-lee]");
    await page.waitForSelector("[data-testid^=conflict-]", { timeout: 15000 });
    ok("one click produces a working prior authorization");

    await page.keyboard.press("Escape");
    await verifyRules(page);
    await verifyDoubleSubmit(page);
    await verifySignatureVoiding(page);
    await verifyOneRunAtATime(page);
  } finally {
    await browser.close();
  }
}


// ---------------------------------------------------------------------------
// The clinical rules. Driven through the interface rather than by reaching into
// the application, so these run against a deployment where no debug handle
// exists. This section exists because a rule that is only ever exercised on one
// phrasing is a rule nobody has actually checked.
// ---------------------------------------------------------------------------
async function verifyRules(page) {
  section("Coverage and clinical rules");

  const openPalette = async () => {
    await page.keyboard.press("Control+K");
    await page.waitForSelector("[data-testid=cmd-input]", { timeout: 5000 });
  };
  const runCommand = async (text) => {
    await openPalette();
    await page.fill("[data-testid=cmd-input]", text);
    await page.click(`.cmd-item:has-text("${text}")`);
    await page.waitForTimeout(250);
  };
  const setField = async (fieldId, value) => {
    const sel = `[data-testid=field-${fieldId}] input, [data-testid=field-${fieldId}] textarea`;
    await page.fill(sel, value);
    await page.waitForTimeout(180);
  };
  const conflicts = () =>
    page.$$eval("[data-testid^=conflict-]", (els) =>
      els.map((e) => e.getAttribute("data-testid").replace("conflict-", ""))
    );

  // A clean chart, filled correctly, should raise nothing.
  await runCommand("Load patient - Jane Doe");
  await runCommand("Payer - UnitedHealthcare");
  await runCommand("auto-fill the form");
  await page.waitForTimeout(400);
  const clean = await conflicts();
  clean.length === 0
    ? ok("a correctly filled submission raises no conflicts")
    : bad("a correctly filled submission raises no conflicts", "none", clean.join(", "));

  // A diagnosis outside the drug's indications is caught, and correcting it clears.
  await setField("diagnosis_code", "E11.9");
  const mismatch = await conflicts();
  mismatch.includes("indication-mismatch")
    ? ok("a diagnosis outside the drug's indications is caught")
    : bad("a diagnosis outside the drug's indications is caught", "indication-mismatch", mismatch.join(", ") || "none");

  await setField("diagnosis_code", "M06.9");
  const corrected = await conflicts();
  !corrected.includes("indication-mismatch")
    ? ok("correcting the diagnosis clears it, so the rules read the submission")
    : bad("correcting the diagnosis clears it", "no indication-mismatch", corrected.join(", "));

  // A member id belonging to another payer is caught before clinical review.
  await setField("member_id", "AET-55190");
  const member = await conflicts();
  member.includes("member-payer-mismatch")
    ? ok("a member ID from another payer is caught")
    : bad("a member ID from another payer is caught", "member-payer-mismatch", member.join(", ") || "none");
  await setField("member_id", "UHC-88213");

  // A dose the payer cannot match to the label is caught.
  await setField("dose", "800 mg daily");
  const dose = await conflicts();
  dose.includes("dose-out-of-range")
    ? ok("a dose outside the labelled range is caught")
    : bad("a dose outside the labelled range is caught", "dose-out-of-range", dose.join(", ") || "none");
  await setField("dose", "40 mg SC every other week");

  // A drug the payer file does not cover is caught. Aetna covers adalimumab only.
  await runCommand("Load patient - Jane Doe");
  await runCommand("Payer - Aetna");
  await setField("diagnosis_code", "M06.9");
  await setField("hcpcs_code", "J1438");
  const notCovered = await conflicts();
  notCovered.includes("drug-not-covered")
    ? ok("a drug the payer file does not cover is caught")
    : bad("a drug the payer file does not cover is caught", "drug-not-covered", notCovered.join(", ") || "none");

  // Regression guard: a narrative stating the trial ran under the required
  // duration must not be read as satisfying that duration.
  await runCommand("Load patient - Marcus Lee");
  await runCommand("Payer - Aetna");
  await setField("hcpcs_code", "J0135");
  await setField("diagnosis_code", "L40.50");
  await setField("step_therapy", "Methotrexate 1mo, Ongoing - <3 months");
  const qualified = await conflicts();
  qualified.includes("step-insufficient")
    ? ok('"under 3 months" does not satisfy a 3-month step-therapy rule')
    : bad('"under 3 months" does not satisfy a 3-month rule', "step-insufficient", qualified.join(", ") || "none");

  // A genuine trial of adequate length still counts.
  await setField("step_therapy", "Methotrexate 6 months, inadequate response");
  const honest = await conflicts();
  !honest.includes("step-insufficient")
    ? ok("a documented six-month trial does satisfy it")
    : bad("a documented six-month trial satisfies it", "no step-insufficient", honest.join(", "));

  // The score explains itself rather than asserting a number.
  const rationale = await page.$$eval(".risk-factor .risk-why", (els) => els.length);
  rationale > 0
    ? ok("each risk factor explains the weight it carries", `${rationale} explained`)
    : bad("each risk factor explains its weight", "at least one rationale", "none");
}

// ---------------------------------------------------------------------------
// Clicking submit twice is something people do. The approval is single use, so
// the second attempt is refused, and that refusal must not land on top of the
// confirmation for the submission that succeeded.
// ---------------------------------------------------------------------------
async function verifyDoubleSubmit(page) {
  section("Submitting twice by accident");

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".app-shell", { timeout: 15000 });
  await page.click("[data-testid=intro-close]");
  await page.click("[data-testid=start-jane-doe]");
  await page.waitForSelector("[data-testid=field-member_id]", { timeout: 15000 });

  const fields = {
    member_id: "UHC-88213", prescriber_npi: "1487203941", diagnosis_code: "M06.9",
    hcpcs_code: "J0135", dose: "40 mg SC every other week", quantity: "2 syringes / 28 days",
    step_therapy: "Methotrexate 4 months, inadequate response",
    step_exception_rationale: "Documented failure.", medical_necessity: "Necessary.",
  };
  for (const [id, value] of Object.entries(fields)) {
    await page.fill(`[data-testid=field-${id}] input, [data-testid=field-${id}] textarea`, value);
  }
  await page.selectOption("[data-testid=field-attending_attestation] select", "Attested");
  await page.click("[data-testid=field-tb_screen] .evidence-slot");
  await page.click("[data-testid=pick-tb_screen-doc-tb]");

  await page.fill("[data-testid=signer-input]", "Verification Script, MD");
  await page.check("[data-testid=attest-checkbox]");
  await page.click("[data-testid=approve-sign]");
  await page.waitForSelector("[data-testid=submit-btn]:not([disabled])", { timeout: 20000 });

  await page.evaluate(() => {
    const b = document.querySelector("[data-testid=submit-btn]");
    b.click(); b.click(); b.click();
  });
  await page.waitForSelector("[data-testid=submitted-banner]", { timeout: 20000 });
  await page.waitForTimeout(2500);

  const blocked = await page.$("[data-testid=blocked-banner]");
  !blocked
    ? ok("a refused duplicate does not overwrite the confirmation")
    : bad("a refused duplicate does not overwrite the confirmation", "no blocked banner", await page.textContent("[data-testid=blocked-banner]"));

  const disabled = await page.getAttribute("[data-testid=submit-btn]", "disabled");
  disabled !== null
    ? ok("the submit button closes once the submission is accepted")
    : bad("the submit button closes once accepted", "disabled", "still clickable");
}

// ---------------------------------------------------------------------------
// An attestation is a statement about specific values. If those values change,
// it must be made again rather than carried across to a submission the
// clinician has not read.
// ---------------------------------------------------------------------------
async function verifySignatureVoiding(page) {
  section("A signature after the submission changes");

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".app-shell", { timeout: 15000 });
  await page.click("[data-testid=intro-close]");
  await page.click("[data-testid=start-jane-doe]");
  await page.waitForSelector("[data-testid=field-member_id]", { timeout: 15000 });

  const fields = {
    member_id: "UHC-88213", prescriber_npi: "1487203941", diagnosis_code: "M06.9",
    hcpcs_code: "J0135", dose: "40 mg SC every other week", quantity: "2 syringes / 28 days",
    step_therapy: "Methotrexate 4 months, inadequate response",
    step_exception_rationale: "Documented failure.", medical_necessity: "Necessary.",
  };
  for (const [id, value] of Object.entries(fields)) {
    await page.fill(`[data-testid=field-${id}] input, [data-testid=field-${id}] textarea`, value);
  }
  await page.selectOption("[data-testid=field-attending_attestation] select", "Attested");
  await page.click("[data-testid=field-tb_screen] .evidence-slot");
  await page.click("[data-testid=pick-tb_screen-doc-tb]");
  await page.fill("[data-testid=signer-input]", "Verification Script, MD");
  await page.check("[data-testid=attest-checkbox]");
  await page.click("[data-testid=approve-sign]");
  await page.waitForSelector("[data-testid=submit-btn]", { timeout: 20000 });

  // Correct a value after signing.
  await page.fill("[data-testid=field-dose] input", "40 mg SC every 14 days");
  await page.waitForSelector("[data-testid=signature-voided]", { timeout: 10000 });
  ok("changing a signed submission says the signature no longer applies");

  const stillTicked = await page.isChecked("[data-testid=attest-checkbox]");
  !stillTicked
    ? ok("the attestation clears, so it cannot carry over to changed values")
    : bad("the attestation clears when values change", "unchecked", "still ticked");

  const signDisabled = await page.getAttribute("[data-testid=approve-sign]", "disabled");
  signDisabled !== null
    ? ok("signing again requires attesting again")
    : bad("signing again requires attesting again", "disabled until re-attested", "clickable");

  const voided = await page.$(".audit-voided");
  voided
    ? ok("the superseded signature is marked in the audit trail rather than removed")
    : bad("the superseded signature is marked voided", "a voided entry", "none");
}

// ---------------------------------------------------------------------------
// The walkthrough and the comparison both drive the workspace on a timer. The
// comparison presents its figures as measured against one patient and one
// payer, so a second flow writing fields underneath it would make those numbers
// quietly untrue rather than visibly wrong.
// ---------------------------------------------------------------------------
async function verifyOneRunAtATime(page) {
  section("Two scripted runs at once");

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".app-shell", { timeout: 15000 });
  await page.click("[data-testid=intro-watch]");
  await page.waitForSelector("[data-testid=demo-caption]", { timeout: 15000 });

  // Start the comparison while the walkthrough is mid-flight.
  await page.click("[data-testid=open-compare]");
  await page.click("[data-testid=compare-run]");
  await page.waitForSelector("[data-testid=compare-metrics]", { timeout: 90000 });
  await page.waitForTimeout(2000);

  const caption = await page.$("[data-testid=demo-caption]");
  !caption
    ? ok("starting a measurement stops the walkthrough driving the same workspace")
    : bad("the walkthrough stops when a measurement starts", "no caption", await page.textContent("[data-testid=demo-caption]"));

  const label = await page.textContent("[data-testid=watch-demo]");
  label?.trim() !== "Running"
    ? ok("the walkthrough reports itself as stopped")
    : bad("the walkthrough reports itself as stopped", "not Running", label);
}

// ---------------------------------------------------------------------------

async function main() {
  console.log(`CoAuth live verification\ntarget: ${BASE}${DEPLOYED ? "" : "  (local)"}`);

  try {
    await fetch(BASE + "/", { method: "HEAD" });
  } catch {
    console.error(`\nCould not reach ${BASE}. Start the app first, or pass --url <origin>.`);
    process.exit(2);
  }

  await verifyApprovalGate();
  await verifyMcp();
  await verifyHeaders();
  await verifyInBrowser();

  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
  if (fail) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f.name}: expected ${f.expected}, got ${f.actual}`);
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("\nVerification could not complete:", e);
  process.exit(2);
});
