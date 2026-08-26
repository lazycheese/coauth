# CoAuth - an agent-native prior-authorization cockpit

**CoAuth** lets a clinician and an AI agent complete a health-insurance **prior
authorization** together, on the same live page, using the
[WebMCP](https://github.com/webmachinelearning/webmcp) standard. The agent fills
and checks the payer form at machine speed by calling typed tools - never by
scraping the DOM - while the clinician keeps the clinical judgment and the
legally required signature.

Built for the **OpenAI WebMCP Challenge**.

> Up to **82% of denied prior authorizations are overturned on appeal** - they
> were never clinically wrong, just mis-filed. CoAuth fixes the filing and keeps
> the human in charge.

## Why it matters

Today's browser agents fail on write-heavy, multi-step forms, and in this domain
a human is *legally required* to stay in the loop. That combination - agents are
great at the mechanics, humans are mandatory for judgment - is exactly what
WebMCP and true human+agent collaboration are for.

## What the agent can and cannot do

- **Can:** load the patient record, read payer rules, fill every non-judgment
  field, attach evidence, score denial risk, detect clinical conflicts, draft
  the medical-necessity narrative and an appeal letter.
- **Cannot:** fabricate a clinician-judgment field, resolve a critical
  contraindication, or submit. `submit` is **architecturally gated** - it returns
  `blocked` until the clinician signs. The agent physically cannot bypass the
  human.

## The 12 WebMCP tools

| Tool | Kind | Purpose |
|---|---|---|
| `get_workflow_guidance` | read | The site teaches the agent the correct sequence + safety rules |
| `load_patient_context` | read | Load a structured patient record |
| `check_payer_rules` | read | Fetch the payer's required fields and policy |
| `fill_field` | write | Set one form field (typed, sourced from the record) |
| `attach_evidence` | write | Link a clinical document to a field |
| `validate_submission` | read | Per-field pass/fail incl. format checks |
| `assess_denial_risk` | read | Score denial probability + drivers |
| `detect_conflicts` | read | Surface contraindications / unmet step therapy |
| `draft_field` | read | Propose clinician-judgment text (suggestion only) |
| `draft_appeal` | read | Draft a grounded payer appeal letter |
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
with Aetna."* Or click **▶ Watch demo** to run the full narrative autonomously,
or press **⌘K / Ctrl-K** for the tool command palette.

## Stack

Vite · React · TypeScript · Zustand · Vercel (static + edge functions) · WebMCP.
No backend state - the shared store is the single source of truth, so agent tool
calls and human clicks update the same live UI.

## License

MIT - see [LICENSE](./LICENSE).
