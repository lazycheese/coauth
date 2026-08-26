// Vercel Edge Middleware:
//  - acceptmarkdown.com-style content negotiation on "/" (serve Markdown when asked)
//  - agent-friendly 404s: unknown paths get a real 404, with a Markdown body
//    (site map / llms.txt / docs pointers) when the client accepts Markdown.
export const config = { matcher: "/((?!api/|assets/|_vercel/).*)" };

const HOME_MD = `---
title: CoAuth
description: Agent-native prior-authorization cockpit built on the WebMCP standard.
url: https://coauth.vercel.app/
---

# CoAuth

Agent-native prior-authorization cockpit. A clinician and an AI agent complete a
health-insurance prior authorization together on one live page using the WebMCP
standard. The agent fills and checks the payer form via typed tools; the human
keeps clinical judgment and the legally required signature.

> Up to 82% of denied prior authorizations are overturned on appeal - they were
> never clinically wrong, just mis-filed. CoAuth fixes the filing and keeps the
> human in charge.

## WebMCP tools

- get_workflow_guidance - recommended sequence and safety rules
- load_patient_context, check_payer_rules - read the record and payer policy
- fill_field, attach_evidence - complete the form (typed, sourced)
- validate_submission, assess_denial_risk, detect_conflicts - checks
- draft_field, draft_appeal - agent proposes, clinician approves
- submit - human-gated; blocked until the clinician signs

## More

- Agent instructions: /AGENTS.md
- Full description: /llms-full.txt
- Developer portal: /developers
- API (versioned): /openapi.json
- Source: https://github.com/lazycheese/coauth
`;

const NOT_FOUND_MD = `---
title: 404 - Not found
description: The requested path does not exist on CoAuth.
---

# 404 - Not found

That path does not exist on CoAuth. Where to look next:

- Home: /
- Site map: /sitemap.xml
- Agent index: /llms.txt
- Agent instructions: /AGENTS.md
- Developer portal: /developers
- API spec: /openapi.json
`;

// Real static paths served by this site. Anything else is a 404.
const KNOWN = new Set([
  "/", "/index.html", "/404.html",
  "/about", "/about.html", "/contact", "/contact.html",
  "/privacy", "/privacy.html", "/developers", "/developers.html", "/terms", "/terms.html",
  "/og.svg", "/robots.txt", "/sitemap.xml", "/llms.txt", "/llms-full.txt",
  "/AGENTS.md", "/openapi.json", "/.nojekyll", "/.well-known/agents.json",
  "/.well-known/mcp",
]);

function wantsMarkdown(req: Request): boolean {
  return (req.headers.get("accept") || "").includes("text/markdown");
}

// Serve Markdown to known AI crawlers even without an Accept header.
const BOT_UA = /(GPTBot|OAI-SearchBot|ChatGPT-User|ClaudeBot|Claude-Web|Google-Extended|PerplexityBot|CCBot|Bytespider)/i;
function isBot(req: Request): boolean {
  return BOT_UA.test(req.headers.get("user-agent") || "");
}

const MD_HEADERS = { "content-type": "text/markdown; charset=utf-8", vary: "Accept, Accept-Encoding, User-Agent", "cache-control": "public, max-age=300" };

export default function middleware(request: Request): Response | undefined {
  const url = new URL(request.url);
  const path = url.pathname;
  const md = wantsMarkdown(request);

  // Explicit Markdown URL fallback for the homepage.
  if (path === "/index.md") {
    return new Response(HOME_MD, { status: 200, headers: MD_HEADERS });
  }

  if (path === "/") {
    if (md || isBot(request)) {
      return new Response(HOME_MD, { status: 200, headers: MD_HEADERS });
    }
    return undefined; // serve the SPA
  }

  // Known static asset: let Vercel serve it.
  if (KNOWN.has(path)) return undefined;

  // Unknown path: 404. Give agents a Markdown recovery body.
  if (md || isBot(request)) {
    return new Response(NOT_FOUND_MD, { status: 404, headers: MD_HEADERS });
  }
  return undefined; // fall through to Vercel's 404.html (still a 404 status)
}
