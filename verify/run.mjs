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
  // On a deployment a skip is a failure. The checks most worth running are the
  // ones that can only run against real infrastructure, and letting them skip
  // quietly meant a deployment with a broken gate exited 0.
  if (DEPLOYED) return bad(name, "the check to run against a deployment", `skipped: ${why}`);
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
//
// The first check is the one that matters and the one that used to be missing.
// An earlier version of this suite opened by minting an approval with
// signer: "Verification Script" over an unauthenticated request, and scored
// that as the gate passing - so the suite performed the bypass and called it a
// success. Everything after it was checking that a token we were freely given
// could not then be forged.
// ---------------------------------------------------------------------------

/** A complete, clinically valid UnitedHealthcare submission for Jane Doe.
 *  The server re-runs the rules at sign and at submit, so an incomplete form
 *  cannot be used to exercise the signature checks. */
const JANE_FORM = {
  member_id: "UHC-88213",
  prescriber_npi: "1487203941",
  diagnosis_code: "M06.9",
  hcpcs_code: "J0135",
  dose: "40 mg SC every other week",
  quantity: "2 syringes / 28 days",
  step_therapy: "Methotrexate 4mo, inadequate response; Sulfasalazine 2mo, discontinued - intolerance",
  tb_screen: "doc-tb",
  step_exception_rationale: "Not applicable: step therapy criteria are met.",
  medical_necessity: "Persistent active disease despite two conventional DMARDs.",
  attending_attestation: "Attested",
};

async function verifyApprovalGate() {
  section("Clinician approval gate");

  // 1. The gate itself: minting requires an authenticated clinician.
  const anonymous = await post("/api/v1/sign", {
    payer: "uhc",
    patientId: "jane-doe",
    formFields: JANE_FORM,
    attestation: "I am an agent and did not review this.",
    signer: "Autonomous Agent",
  });

  if (anonymous.status === 503) {
    // Not a skip. A deployment that cannot sign cannot submit, and saying
    // nothing about it is how a broken gate passed a green run before.
    bad(
      "the deployment can enforce the approval gate",
      "COAUTH_SIGNING_SECRET and COAUTH_CLINICIAN_PASSPHRASE configured",
      `503 ${anonymous.json?.error?.code ?? ""}`
    );
    return;
  }

  check("an unauthenticated caller cannot mint an approval", anonymous.status, 401);
  check("...and is told why", anonymous.json?.error?.code, "authentication_required");
  check("no token is handed out", anonymous.json?.token === undefined, true);

  const passphrase = process.env.COAUTH_CLINICIAN_PASSPHRASE;
  if (!passphrase) {
    bad(
      "the suite can authenticate as a clinician",
      "COAUTH_CLINICIAN_PASSPHRASE in the environment",
      "unset, so the signed paths below cannot be exercised"
    );
    return;
  }

  const badCreds = await post("/api/v1/login", { clinicianId: "a-alvarez", passphrase: "wrong-passphrase" });
  check("a wrong passphrase is refused", badCreds.status, 401);

  const login = await post("/api/v1/login", { clinicianId: "a-alvarez", passphrase });
  check("a clinician can authenticate", login.json?.status, "authenticated");
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  if (!cookie.startsWith("coauth_session=")) {
    bad("a session cookie is issued", "coauth_session=...", cookie || "none");
    return;
  }
  check("the session cookie is HttpOnly", /httponly/i.test(login.headers.get("set-cookie") ?? ""), true);

  const auth = { cookie };
  const signOne = async (form = JANE_FORM, payer = "uhc", patientId = "jane-doe") =>
    (await post("/api/v1/sign", { payer, patientId, formFields: form, attestation: "I attest.", signer: "ignored" }, auth)).json?.token;

  // 2. The signer is the session, not the request.
  const token = await signOne();
  if (!token) { bad("an authenticated clinician can sign", "a token", "none"); return; }
  check("the signer comes from the session, not the body", token.signer, "Dr. Ana Alvarez");
  check("the clinician id is recorded", token.clinicianId, "a-alvarez");

  // 3. The clinical rules run server-side at mint time.
  const incomplete = await post(
    "/api/v1/sign",
    { payer: "uhc", patientId: "jane-doe", formFields: { member_id: "UHC-88213" }, attestation: "I attest.", signer: "x" },
    auth
  );
  check("an incomplete submission cannot be signed", incomplete.json?.error?.code, "incomplete_submission");

  // 4. The submission paths.
  const honest = await post("/api/v1/submit", { payer: "uhc", patientId: "jane-doe", formFields: JANE_FORM, token });
  check("an honest submission is accepted", honest.json?.status, "submitted");
  check("the confirmation is derived from the approval, not the form", honest.json?.confirmationId?.slice(3), token.jti.slice(0, 8).toUpperCase());

  const replay = await post("/api/v1/submit", { payer: "uhc", patientId: "jane-doe", formFields: JANE_FORM, token });
  check("the same approval cannot be used twice", replay.json?.error?.code, "approval_already_used");

  const fresh = await signOne();

  const unsigned = await post("/api/v1/submit", { payer: "uhc", patientId: "jane-doe", formFields: JANE_FORM });
  check("an unsigned submission is refused", unsigned.json?.error?.code, "approval_required");

  const forged = await post("/api/v1/submit", {
    payer: "uhc", patientId: "jane-doe", formFields: JANE_FORM,
    token: { ...fresh, signer: "Somebody Else", mac: "0".repeat(64) },
  });
  check("a forged approval is refused", forged.json?.error?.code, "invalid_signature");

  const renamed = await post("/api/v1/submit", {
    payer: "uhc", patientId: "jane-doe", formFields: JANE_FORM, token: { ...fresh, signer: "Somebody Else" },
  });
  check("the signer cannot be swapped after minting", renamed.json?.error?.code, "invalid_signature");

  const tampered = await post("/api/v1/submit", {
    payer: "uhc", patientId: "jane-doe", formFields: { ...JANE_FORM, dose: "800 mg daily" }, token: fresh,
  });
  check("editing the form after signing invalidates it", tampered.json?.error?.code, "form_modified");

  const crossPayer = await post("/api/v1/submit", { payer: "aetna", patientId: "jane-doe", formFields: JANE_FORM, token: fresh });
  check("an approval cannot be replayed at another payer", crossPayer.json?.error?.code, "payer_mismatch");

  const crossPatient = await post("/api/v1/submit", { payer: "uhc", patientId: "marcus-lee", formFields: JANE_FORM, token: fresh });
  check("an approval cannot be moved to another chart", crossPatient.json?.error?.code, "patient_mismatch");

  // 5. The clinical gate is enforced at submit independently of the page.
  //    Marcus Lee is QuantiFERON positive, so a biologic is a critical conflict.
  const marcusForm = {
    ...JANE_FORM,
    member_id: "UHC-55719",
    step_therapy: "Methotrexate 1mo, ongoing",
  };
  const marcusSigned = await post(
    "/api/v1/sign",
    { payer: "uhc", patientId: "marcus-lee", formFields: marcusForm, attestation: "I attest.", signer: "x" },
    auth
  );
  check(
    "a submission with an unresolved critical conflict cannot be signed",
    marcusSigned.json?.error?.code,
    "critical_conflict"
  );

  // 6. Sign-out actually ends the session.
  const out = await fetch(BASE + "/api/v1/session", { method: "DELETE", headers: auth });
  check("a clinician can sign out", out.status, 200);
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

  // An unknown patient id used to reach the handler and come back as a tool
  // result with isError. It is now caught by the declared enum before the tool
  // runs, which is the stronger answer: the server enforces its own schema.
  const call = await post(path, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "get_patient", arguments: { id: "nobody" } },
  }, { "mcp-protocol-version": "2025-06-18" });
  check("an argument outside the schema is refused before the tool runs", call.json?.error?.code, -32602);
  check("...and no tool result is fabricated for it", call.json?.result, undefined);

  const unknown = await post(path, {
    jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "no_such_tool" },
  }, { "mcp-protocol-version": "2025-06-18" });
  check("an unknown tool is a protocol error", unknown.json?.error?.code, -32602);
}

// ---------------------------------------------------------------------------
// The MCP server must enforce the schemas it publishes. A schema the server
// does not check is a suggestion, and a stricter client diverges from it.
// ---------------------------------------------------------------------------
async function verifyMcpSchemas() {
  section("MCP schema enforcement");

  const rpc = async (method, params) =>
    (await post("/.well-known/mcp", { jsonrpc: "2.0", id: 1, method, params }, { accept: "application/json" })).json;

  const missing = await rpc("tools/call", { name: "get_patient", arguments: {} });
  check("omitting a required argument is -32602, not a result", missing?.error?.code, -32602);

  const wrongType = await rpc("tools/call", { name: "validate_submission", arguments: { payer: "uhc", formFields: "not-an-object" } });
  check("an argument of the wrong type is refused", wrongType?.error?.code, -32602);

  const badEnum = await rpc("tools/call", { name: "get_patient", arguments: { id: "nobody" } });
  check("a value outside the declared enum is refused", badEnum?.error?.code, -32602);

  // The enum used to list two of the three patients that exist, so a client
  // respecting the schema could never reach the third.
  const list = await rpc("tools/list", {});
  const patientTool = list?.result?.tools?.find((t) => t.name === "get_patient");
  const ids = patientTool?.inputSchema?.properties?.id?.enum ?? [];
  ids.includes("ana-torres")
    ? ok("every patient the server serves is in the schema enum", ids.join(", "))
    : bad("the schema enum lists every patient served", "includes ana-torres", ids.join(", ") || "none");

  patientTool?.outputSchema
    ? ok("tools declare an outputSchema alongside structuredContent")
    : bad("tools declare an outputSchema", "an outputSchema", "none");

  const called = await rpc("tools/call", { name: "get_patient", arguments: { id: "ana-torres" } });
  const blocks = called?.result?.content ?? [];
  blocks.length > 1 && blocks[1]?.text?.trim().startsWith("{")
    ? ok("the serialized result is in content as well as structuredContent")
    : bad("content carries the serialized result", "a JSON text block", `${blocks.length} block(s)`);

  const wrongAccept = await post("/.well-known/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }, { accept: "text/html" });
  check("a client that will not accept JSON is refused", wrongAccept.status, 406);
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

    // The whole agent flow, started the way a person starts it.
    //
    // The walkthrough stops before the signature, and that is the behaviour
    // being checked. An earlier version wrote the attending attestation itself
    // and called sign() with an invented name, so it demonstrated the opposite
    // of what the product claims. It now runs the agent as far as an agent
    // goes and hands over.
    await page.click('[data-testid=intro-watch]');
    // The run blocks twice: first on the TB contraindication, then - after the
    // clinician's override and the accepted draft - on the missing signature.
    // Wait for the closing caption so the banner read is the final one.
    await page.waitForFunction(
      () => /as far as an agent goes/i.test(document.querySelector("[data-testid=demo-caption]")?.textContent ?? ""),
      { timeout: 120000 }
    );
    const blockedText = await page.textContent("[data-testid=blocked-banner]");
    /signature|sign/i.test(blockedText ?? "")
      ? ok("the walkthrough runs the agent to the gate and is blocked there", blockedText?.trim().slice(0, 80))
      : bad("the walkthrough is blocked at the signature", "a signature-related block", blockedText?.trim() ?? "none");

    const submitted = await page.$("[data-testid=submitted-banner]");
    !submitted
      ? ok("the scripted walkthrough never reaches a submission on its own")
      : bad("the walkthrough does not submit by itself", "no confirmation", await page.textContent("[data-testid=submitted-banner]"));

    // And the clinician can then finish it, which is the other half of the claim.
    if (await signInAsClinician(page)) {
      const judgmentInputs = await page.$$("[data-testid=field-medical_necessity] textarea");
      if (judgmentInputs.length) {
        await page.fill("[data-testid=field-medical_necessity] textarea", "Reviewed and adopted by the attending.");
      }
      await page.selectOption("[data-testid=field-attending_attestation] select", "Attested").catch(() => {});
      await page.waitForTimeout(400);
      const attest = await page.$("[data-testid=attest-checkbox]:not([disabled])");
      if (attest) {
        await page.check("[data-testid=attest-checkbox]");
        await page.click("[data-testid=approve-sign]");
        await page.waitForSelector("[data-testid=submit-btn]:not([disabled])", { timeout: 20000 });
        await page.click("[data-testid=submit-btn]");
        await page.waitForSelector("[data-testid=submitted-banner]", { timeout: 20000 });
        ok("an authenticated clinician can finish what the agent prepared");

        const audit = await page.textContent("[data-testid=audit-log]");
        audit?.includes("verified by the server")
          ? ok("the audit trail records a server-verified signature")
          : bad("the audit trail records a server-verified signature", "verified by the server", audit?.trim() ?? "no audit trail");
        audit?.includes("Alvarez")
          ? ok("the audit trail names the authenticated clinician, not a typed string")
          : bad("the audit trail names the authenticated clinician", "Dr. Ana Alvarez", audit?.trim() ?? "none");
      } else {
        bad("the clinician can sign after the walkthrough", "an enabled attestation", "still blocked");
      }
    } else {
      bad("the suite can authenticate as a clinician", "COAUTH_CLINICIAN_PASSPHRASE in the environment", "unset");
    }

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
    // This row used to be asserted against a literal 0 in the runner, which
    // made the check unfailable. The tool path now attempts every field,
    // including the clinician's, and the count is of what the tool surface
    // actually let through - so a regression in fill_field's refusal moves this
    // number and the check notices.
    const judgmentRow = rows.find((r) => r.startsWith("Clinician-only fields written to"));
    judgmentRow && /\|\s*0\s*$/.test(judgmentRow)
      ? ok("the tool path is refused every clinician-only field it attempts", judgmentRow)
      : bad("the tool path is refused every clinician-only field", "trailing 0", judgmentRow ?? "row missing");

    // The baseline, driving the same store, must write to some of them: it has
    // no way to tell them apart. If both columns are 0 the comparison is
    // measuring nothing.
    const baselineJudgment = judgmentRow?.split("|")[1]?.trim();
    Number(baselineJudgment) > 0
      ? ok("the DOM baseline does write to clinician-only fields, so the columns differ", `baseline ${baselineJudgment}`)
      : bad("the DOM baseline writes to clinician-only fields", "> 0", baselineJudgment ?? "row missing");

    // The conflict counts are read from the store on both sides now, so a row
    // of zeroes would mean the rules never ran.
    const conflictRow = rows.find((r) => r.startsWith("Clinical conflicts surfaced"));
    const toolConflicts = Number(conflictRow?.split("|")[2]?.trim());
    toolConflicts > 0
      ? ok("the tool path surfaces clinical conflicts from the live rules engine", conflictRow)
      : bad("the tool path surfaces clinical conflicts", "> 0", conflictRow ?? "row missing");

    // No timing is presented any more, because none of it was measured.
    const hasWallClock = rows.some((r) => r.startsWith("Wall clock"));
    !hasWallClock
      ? ok("no fabricated timing is presented as a measurement")
      : bad("no timing row is shown", "no Wall clock row", "a Wall clock row is present");

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
    await verifyUnsavedGuard(page);
    await verifyRegistrationIsIdempotent(page);
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

  // Nor does a longer duration written into the narrative. Text could only ever
  // loosen the criterion - any figure found in it was max'd against the chart -
  // so a sentence could satisfy a requirement the record did not support.
  await setField("step_therapy", "Methotrexate 6 months, inadequate response");
  const narrative = await conflicts();
  narrative.includes("step-insufficient")
    ? ok("a six-month trial asserted only in free text does not satisfy it either")
    : bad("narrative text cannot satisfy step therapy", "step-insufficient", narrative.join(", ") || "none");

  // The regression this replaces: a duration mentioned in passing, with the
  // narrative stating plainly that no DMARD was started.
  await setField("step_therapy", "Patient has had symptoms for 24 months. No DMARD has been started.");
  const passing = await conflicts();
  passing.includes("step-insufficient")
    ? ok('"symptoms for 24 months" with no DMARD started does not clear step therapy')
    : bad("a duration in passing does not clear step therapy", "step-insufficient", passing.join(", ") || "none");

  // A chart that genuinely documents a failed trial of adequate length does
  // satisfy it. Jane Doe has methotrexate for 4 months, recorded as failed.
  await runCommand("Load patient - Jane Doe");
  await runCommand("Payer - UnitedHealthcare");
  await setField("hcpcs_code", "J0135");
  await setField("diagnosis_code", "M06.9");
  const charted = await conflicts();
  !charted.includes("step-insufficient")
    ? ok("a failed four-month trial recorded in the chart does satisfy it")
    : bad("a charted failed trial satisfies step therapy", "no step-insufficient", charted.join(", "));

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
/** Sign in through the interface, the way a clinician does.
 *
 * There is no way to shortcut this: minting an approval requires the session
 * cookie, and the cookie is HttpOnly, so the page cannot fabricate one. */
async function signInAsClinician(page) {
  const passphrase = process.env.COAUTH_CLINICIAN_PASSPHRASE;
  if (!passphrase) return false;
  const signin = await page.$("[data-testid=clinician-signin]");
  if (!signin) return true; // already authenticated in this browser context
  await page.selectOption("[data-testid=signin-clinician]", "a-alvarez");
  await page.fill("[data-testid=signin-passphrase]", passphrase);
  await page.click("[data-testid=signin-submit]");
  await page.waitForSelector("[data-testid=signer-identity]", { timeout: 15000 });
  return true;
}

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

  if (!(await signInAsClinician(page))) {
    bad("the double-submit scenario can sign", "COAUTH_CLINICIAN_PASSPHRASE in the environment", "unset");
    return;
  }
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
  if (!(await signInAsClinician(page))) {
    bad("the signature-voiding scenario can sign", "COAUTH_CLINICIAN_PASSPHRASE in the environment", "unset");
    return;
  }
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

  // The other direction, which was never tested. The comparison's cancel flag
  // used to be checked only between its two phases and was never threaded into
  // the fill loops, so a walkthrough starting mid-measurement left both runs
  // driving the same store.
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".app-shell", { timeout: 15000 });
  await page.click("[data-testid=intro-close]");
  await page.click("[data-testid=start-jane-doe]");
  await page.waitForSelector("[data-testid=field-member_id]", { timeout: 15000 });
  await page.click("[data-testid=open-compare]");
  await page.click("[data-testid=compare-run]");
  await page.waitForSelector("[data-testid=compare-progress]", { timeout: 15000 });

  // Take over with the walkthrough while the measurement is running. Forced
  // because the comparison dialog is over the button: the point of the check is
  // what happens when a second run starts, not whether the overlay is modal.
  await page.click("[data-testid=watch-demo]", { force: true });
  await page.waitForTimeout(2500);

  const stillMeasuring = await page.$("[data-testid=compare-progress]");
  !stillMeasuring
    ? ok("starting the walkthrough stops a measurement in flight")
    : bad("the measurement stops when the walkthrough starts", "no progress line", await page.textContent("[data-testid=compare-progress]"));

  const runButton = await page.textContent("[data-testid=compare-run]").catch(() => null);
  runButton === null || runButton.trim() !== "Running"
    ? ok("the measurement reports itself as stopped", runButton?.trim() ?? "dialog closed")
    : bad("the measurement reports itself as stopped", "not Running", runButton);
}

// ---------------------------------------------------------------------------
// Nothing about a submission is persisted, on purpose. The cost of that choice
// is that a reload discards the work, so it should ask first, and only when
// there is something to lose.
// ---------------------------------------------------------------------------
async function verifyUnsavedGuard(page) {
  section("Leaving with unfinished work");

  const wouldWarn = () =>
    page.evaluate(() => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    });

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".app-shell", { timeout: 15000 });
  await page.click("[data-testid=intro-close]");

  (await wouldWarn())
    ? bad("an empty workspace does not interrupt", "no prompt", "prompted")
    : ok("an empty workspace does not interrupt");

  await page.click("[data-testid=start-jane-doe]");
  await page.waitForSelector("[data-testid=field-member_id]", { timeout: 15000 });
  await page.fill("[data-testid=field-member_id] input", "UHC-88213");
  await page.waitForTimeout(300);

  (await wouldWarn())
    ? ok("a part-finished authorization asks before it is discarded")
    : bad("a part-finished authorization asks first", "prompted", "no prompt");
}

// ---------------------------------------------------------------------------
// A runtime can attach after the page loads, so registration is attempted
// repeatedly. A runtime that keeps what it is given must not end up holding the
// same tools several times over.
// ---------------------------------------------------------------------------
async function verifyRegistrationIsIdempotent(page) {
  section("Registering while a runtime arrives late");

  await page.goto(BASE + "/?registration-probe", { waitUntil: "domcontentloaded" });
  const result = await page.evaluate(async () => {
    const calls = [];
    const signals = [];
    // A runtime that accumulates, attached while the retry loop is polling.
    document.modelContext = {
      registerTool(def, opts) {
        calls.push(def.name);
        if (opts && opts.signal) signals.push(opts.signal);
      },
    };
    await new Promise((r) => setTimeout(r, 7000));
    return { total: calls.length, distinct: new Set(calls).size, signalled: signals.length };
  });

  result.total === result.distinct
    ? ok("tools are registered once, not once per attempt", `${result.total} registrations`)
    : bad("tools are registered once", `${result.distinct}`, `${result.total} calls`);

  result.signalled === result.total && result.total > 0
    ? ok("each registration carries a signal so it can be withdrawn")
    : bad("each registration can be withdrawn", "a signal per tool", `${result.signalled} of ${result.total}`);

  await verifyJudgmentFieldsAreRefused(page);
}

// ---------------------------------------------------------------------------
// The product's central promise: the clinician holds the judgment calls.
//
// This drives the real registered tools through a model-context surface, which
// is the same route an agent takes. Previously this was stated in the schema
// description and the workflow guidance and enforced nowhere, so an agent could
// set the attending attestation and the form reported itself ready to sign.
// ---------------------------------------------------------------------------
async function verifyJudgmentFieldsAreRefused(page) {
  section("An agent reaching for a clinician-judgment field");

  await page.goto(BASE + "/?judgment-probe", { waitUntil: "domcontentloaded" });
  const probe = await page.evaluate(async () => {
    const tools = new Map();
    document.modelContext = { registerTool: (def) => tools.set(def.name, def) };
    await new Promise((r) => setTimeout(r, 4000));
    if (!tools.size) return { error: "no tools registered" };

    const call = async (name, args) => tools.get(name)?.execute(args ?? {});
    await call("load_patient_context", { patientId: "jane-doe" });
    await call("check_payer_rules", { payer: "uhc" });

    const fill = tools.get("fill_field");
    const attempt = await fill.execute({ fieldId: "attending_attestation", value: "Attested" });
    const necessity = await fill.execute({ fieldId: "medical_necessity", value: "Patient has failed all therapy." });
    const state = await call("validate_submission", {});
    const enumIds = fill.inputSchema?.properties?.fieldId?.enum ?? [];

    return {
      attestationStatus: attempt?.status ?? attempt?.structuredContent?.status,
      necessityStatus: necessity?.status ?? necessity?.structuredContent?.status,
      enumHasJudgment: enumIds.includes("attending_attestation") || enumIds.includes("medical_necessity"),
      validation: state?.validation ?? state?.structuredContent?.validation ?? null,
      rawState: JSON.stringify(state ?? null).slice(0, 200),
    };
  });

  if (probe.error) {
    bad("the judgment-field probe can drive the tools", "registered tools", probe.error);
    return;
  }

  check("fill_field refuses the attending attestation", probe.attestationStatus, "refused");
  check("fill_field refuses the medical-necessity statement", probe.necessityStatus, "refused");
  probe.enumHasJudgment === false
    ? ok("judgment fields are absent from the fill_field schema enum")
    : bad("judgment fields are absent from the enum", "absent", "present");
  // The refusal has to be visible in the submission state, not just in the tool
  // response: the failure mode being guarded against is a form that reports
  // itself ready to sign because an agent filled the clinician's fields.
  probe.validation && probe.validation.judgmentCount > 0
    ? ok("the clinician's fields are still outstanding after the attempt", `${probe.validation.judgmentCount} pending`)
    : bad("the clinician's fields remain outstanding", "judgmentCount > 0", probe.rawState);
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
  await verifyMcpSchemas();
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
