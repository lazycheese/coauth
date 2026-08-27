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
  } finally {
    await browser.close();
  }
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
