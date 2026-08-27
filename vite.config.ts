import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Serves the same /api handlers locally that Vercel Edge runs in prod.
function devApi(): Plugin {
  return {
    name: "dev-api",
    configureServer(server) {
      process.env.COAUTH_SIGNING_SECRET ||= "dev-only-signing-secret-not-for-production";
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "", "http://localhost");
        const isMcp = url.pathname === "/.well-known/mcp";
        if (!url.pathname.startsWith("/api/") && !isMcp) return next();
        if (isMcp) {
          const mod = await server.ssrLoadModule("/api/mcp.ts");
          let raw = "";
          for await (const c of req) raw += c;
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
          const out: Response = await mod.default(
            new Request("http://localhost" + url.pathname, {
              method: req.method,
              headers,
              body: req.method === "GET" || req.method === "DELETE" ? undefined : raw || undefined,
            })
          );
          res.statusCode = out.status;
          out.headers.forEach((v, k) => res.setHeader(k, v));
          res.end(await out.text());
          return;
        }
        // Treat /api/v1/* the same as the unversioned aliases locally.
        const path = url.pathname.replace("/api/v1/", "/api/");
        const h = await server.ssrLoadModule("/api/_handlers.ts");
        const send = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(body));
        };
        try {
          if (path.startsWith("/api/patient/")) {
            const id = path.split("/").pop() ?? "";
            const r = h.patientResult(id);
            return send(r.status, r.body);
          }
          if (path === "/api/payer-rules") {
            const r = h.payerRulesResult(url.searchParams.get("payer") ?? "");
            return send(r.status, r.body);
          }
          // Edge handlers that take a Request: run them as-is so dev matches prod.
          if (path === "/api/sign" || path === "/api/submit") {
            const mod = await server.ssrLoadModule(
              path === "/api/sign" ? "/api/v1/sign.ts" : "/api/v1/submit.ts"
            );
            let raw = "";
            for await (const c of req) raw += c;
            const request = new Request("http://localhost" + url.pathname, {
              method: req.method,
              headers: { "content-type": "application/json" },
              body: raw || undefined,
            });
            const out: Response = await mod.default(request);
            res.statusCode = out.status;
            res.setHeader("content-type", "application/json");
            res.end(await out.text());
            return;
          }
          if (path === "/api/validate") {
            let raw = "";
            for await (const c of req) raw += c;
            const { payer, formFields } = raw ? JSON.parse(raw) : {};
            const r = h.validateResult(payer ?? "", formFields ?? {});
            return send(r.status, r.body);
          }
          return send(404, { error: "unknown api route" });
        } catch (e) {
          return send(500, { error: String(e) });
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), devApi()],
});
