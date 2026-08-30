# CoAuth - an agent-native prior-authorization cockpit

**CoAuth** lets a clinician and an AI agent complete a health-insurance **prior
authorization** together, on the same live page, using the
[WebMCP](https://github.com/webmachinelearning/webmcp) standard. The agent fills
and checks the payer form by calling typed tools rather than reading the
rendered page, while the clinician keeps the judgment calls and the signature.

Built for the **OpenAI WebMCP Challenge**.

> About **82% of denied prior authorizations are overturned on appeal**: the
> clinical decision is usually fine, the paperwork is not. CoAuth works on the
> paperwork and leaves the decision with the clinician.

## Why it matters

Today's browser agents fail on write-heavy, multi-step forms, and in this domain
a human is *legally required* to stay in the loop. That combination - agents are
great at the mechanics, humans are mandatory for judgment - is exactly what
WebMCP and true human+agent collaboration are for.

## Signing in (for reviewers)

Signing requires an authenticated clinician, so the demo ships with a seeded
directory and one passphrase:

    Clinician:  Dr. Ana Alvarez  (or Dr. Jae Park)
    Passphrase: coauth-demo-clinician-2026

The passphrase is deliberately **not** shown anywhere in the page. It is a
credential, and a credential printed into the DOM is a credential any agent
driving the page can read - which would quietly reopen the hole the sign-in
exists to close. So it lives here, where a person reading the repository finds
it and an agent working the form does not.

That is the trade-off being made, stated plainly: a shared demo passphrase is
not identity assurance, and a real deployment needs a real identity provider
and per-clinician credentials. What the demo does establish is the boundary -
that minting an approval requires something the agent cannot obtain, and that
the signer recorded in the audit trail is whoever authenticated rather than a
string in a request body.

## What the agent can and cannot do

- **Can:** load the patient record, read payer rules, fill every non-judgment
  field, attach evidence, score denial risk, detect clinical conflicts, draft
  the medical-necessity narrative and an appeal letter.
- **Cannot:** fill a clinician-judgment field, resolve a critical
  contraindication, or submit.

Both halves of that are enforced in code rather than described in prose, which
was not true of an earlier version of this project and is worth being explicit
about:

- `fill_field` and `attach_evidence` both **refuse** any field the payer marks
  as requiring clinician judgment. The judgment field ids are absent from their
  schema enums and rejected by the executors, so a model that ignores the
  description still cannot write one. The Review panel refuses to enable signing
  over a judgment field whose provenance is an agent, and provenance follows the
  browser's `isTrusted` flag, so a value written by a script is recorded as the
  script's even when it arrives through the form.
- An approval is minted **only for an authenticated clinician session**
  (`POST /api/v1/login`, an HttpOnly cookie the page cannot read). The signer
  recorded in the token is taken from that session and never from the request
  body, so the audit trail is not self-asserted. There is no tool, on the page
  or over MCP, that authenticates.
- `POST /api/v1/submit` verifies the HMAC over a digest of the exact payer,
  chart and form, checks the TTL, claims the approval once, **and independently
  re-runs the same clinical rules the page runs**. Skipping the interface skips
  none of them.

A submission is refused when it is unsigned, when the approval was forged, when
a field changed after signing, when the approval has already been used, when it
is replayed against a different payer or a different patient, when required
fields are missing or malformed, and when a critical clinical conflict is
unresolved. Every one of those refusals is exercised by `npm run verify`
against the live deployment.

## The 13 WebMCP tools

| Tool | Kind | Purpose |
|---|---|---|
| `get_workflow_guidance` | read | The site teaches the agent the correct sequence + safety rules |
| `get_submission_state` | read | Read the whole current submission, provenance and gate status |
| `load_patient_context` | read | Load a structured patient record |
| `check_payer_rules` | read | Fetch the payer's required fields and policy |
| `fill_field` | write | Set one form field (typed, sourced from the record) |
| `attach_evidence` | write | Link a clinical document to a field |
| `validate_submission` | read | Per-field pass/fail incl. format checks |
| `assess_denial_risk` | read | Heuristic denial-risk score and its drivers |
| `detect_conflicts` | read | Surface contraindications / unmet step therapy |
| `draft_field` | read | Propose clinician-judgment text (suggestion only) |
| `draft_appeal` | read | Draft an appeal letter from the record and payer policy |
| `flag_for_human` | write | Mark a field as needing clinician input |
| `submit` | **human-gated** | Submit - blocked until the clinician signs |

Tools are registered on both `document.modelContext` and
`navigator.modelContext` for compatibility across browser/agent versions.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
```

Open in **ChatGPT's browser** or **Chrome 149+ with WebMCP enabled** to drive it
with your own prompts, e.g. *"Start a prior auth for Marcus Lee's Humira request
with Aetna."* Or click **Scripted walkthrough** to watch the agent half of the
flow run on its own - it stops at the signature, which is the clinician's - or
press **Cmd-K / Ctrl-K** for the tool command palette.

## Verifying it

The claims this project makes are claims about the deployed system, so they are
checked against a running one rather than against stubs:

```bash
npm run verify                                    # a local dev server
npm run verify -- --url https://coauth.vercel.app # a deployment
```

The script drives the product over HTTP and through a real browser. It attempts
to submit without a signature, with a forged approval, with a form edited after
signing, with an approval already used, and with one replayed at a different
payer; it checks the MCP endpoint against the Streamable HTTP spec; it confirms
the approval UI cannot be framed; and it clicks through the whole walkthrough,
confirming that production ships no inspection handle, that a document carrying
instruction-like text is flagged, and that the tool surface refuses every
clinician-only field it is asked to write.

It also drives the registered WebMCP tools through a model-context surface and
attempts, as an agent would, to set the attending attestation - which is the
single claim this project rests on.

Browser checks need a browser: `npx playwright install chromium`. Without one
they are skipped and the HTTP checks still run.

## How it fits together

```
browser
  React interface ─────────────┐
  humanActions / scriptedAgent │  every UI action goes through the action layer,
                               │  so a click is recorded as a human action
  WebMCP registration ─────────┤  the same tools, registered on
  (document/navigator          │  document.modelContext for a real agent
   .modelContext)              │
                               ▼
                        Zustand store            single source of truth
                               │
                     rules/  validate · risk · drafts · untrusted
                               │
Vercel edge ───────────────────┴───────────────────────────────────
  /api/v1/*            patient, payer rules, validation
  /api/v1/sign         mints a clinician approval (HMAC, server-side secret)
  /api/v1/submit       verifies it against the exact submission
  /.well-known/mcp     read-only MCP server (Streamable HTTP)
  middleware           markdown negotiation, agent-friendly 404s
```

The rules read the submitted form, not just the chart, so what the agent fills
changes the outcome: a wrong ICD-10 code raises a conflict and correcting it
clears one.

## Limitations

This is a demonstration built for a hackathon. It is worth being exact about
what that does and does not mean.

- **The data is fictional.** Three patients, three payers, two drugs. No real
  patient information is present, and none should be entered.
- **It is not a medical device** and not clinical decision support. The
  denial-risk score is a small additive rule model with hand-chosen weights, not
  a trained or validated one, and it is labelled as heuristic in the interface.
- **Drafted clinical text is scaffolding.** It states what the record supports
  and leaves every clinical conclusion to the clinician. It is not usable prose
  as-is and is marked as a draft.
- **The signer is authenticated against a shared demo credential.** Minting an
  approval requires a clinician session, and the signer recorded in the token
  comes from that session rather than from the request. But every demo clinician
  shares one passphrase, and that passphrase is published in this README, so
  anyone who reads it can authenticate as Dr. Alvarez. What the gate establishes
  is that signing requires a credential and that the audit trail records a
  server-established identity. What it does not establish is that the identity
  belongs to the person using it. Real use needs an identity provider and
  per-clinician credentials.
- **The clinician-judgment control is page-side, and the server cannot check
  it.** `fill_field` and `attach_evidence` refuse those fields, and the review
  panel refuses to sign over agent-written or script-written values. All of that
  lives in the browser. The server can see that a judgment field is filled; it
  cannot see who typed it. So a caller holding a valid session can sign a
  submission whose judgment text an agent wrote. The provenance rules are what
  keep an agent driving the page from doing it, not a server-side guarantee.
- **Replay protection is best-effort here.** Approvals are single-use, and the
  claim is atomic when a KV store is configured. This deployment has none, so it
  falls back to per-instance memory and the API says so in its response rather
  than implying a guarantee it cannot make.
- **Injection detection is best-effort.** Record text that reads as an
  instruction is flagged, but any pattern matcher can be evaded. The protection
  that matters is structural: judgment fields cannot be filled by a tool and
  submission requires the server-verified signature.
- **No rate limiting**, for the same reason as replay: nothing to count in.
- **The API is public and unauthenticated**, which is fine for fictional data
  and would not be for anything else.

## Stack

Vite · React · TypeScript · Zustand · Vercel (static + edge functions) · WebMCP.
No backend state - the shared store is the single source of truth, so agent tool
calls and human clicks update the same live UI.

## License

MIT - see [LICENSE](./LICENSE).
