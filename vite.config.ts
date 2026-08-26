import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Serves the same /api handlers locally that Vercel Edge runs in prod.
function devApi(): Plugin {
  return {
    name: "dev-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "", "http://localhost");
        if (!url.pathname.startsWith("/api/")) return next();
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
  // GitHub Pages serves from /<repo>/; Vercel and local serve from root.
  base: process.env.GITHUB_PAGES ? "/coauth/" : "/",
  // On static hosts (Pages) there is no /api - tools use the in-bundle seed directly.
  define: { __STATIC_HOST__: JSON.stringify(!!process.env.GITHUB_PAGES) },
  plugins: [react(), devApi()],
});
