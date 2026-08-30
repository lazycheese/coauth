import { tools } from "../mcp/registerTools";
import { Dialog } from "./Dialog";

export function Intro({ onWatch, onClose }: { onWatch: () => void; onClose: () => void }) {
  return (
    <Dialog title="About CoAuth" testId="intro-overlay" className="intro-modal" onClose={onClose}>
      <>
        <div className="intro-mark">CoAuth</div>
        <h1>A prior authorization a clinician and an agent fill out together.</h1>
        <p className="intro-lead">
          In Medicare Advantage in 2024, <strong>80.7% of appealed prior-authorization denials were
          fully or partially overturned</strong>, and only 11.5% were appealed at all{" "}
          (<a href="https://www.kff.org/medicare/medicare-advantage-insurers-made-nearly-53-million-prior-authorization-determinations-in-2024/" target="_blank" rel="noreferrer">KFF</a>).
          Most denials that get contested turn out to have been wrong, and most are never contested. CoAuth exposes the payer form to an AI agent as <strong>WebMCP
          tools</strong>, so the agent handles the fields and the checks while the clinician keeps the judgment
          calls and the signature.
        </p>
        <ul className="intro-points">
          <li><strong>{tools.length} WebMCP tools.</strong> The agent calls typed functions instead of scraping the page.</li>
          <li><strong>Server-verified signature.</strong> The API rejects any submission that is unsigned, forged, or edited after the clinician signed it.</li>
          <li><strong>Catches issues early.</strong> Contraindications, unmet step therapy, and a denial-risk score.</li>
        </ul>
        <div className="intro-actions">
          <button className="btn btn-primary" data-testid="intro-watch" style={{ width: "auto" }} onClick={onWatch}>Play scripted walkthrough (30s)</button>
          <button className="btn" data-testid="intro-close" style={{ width: "auto" }} onClick={onClose}>Explore it myself</button>
        </div>
        <p className="intro-foot muted">Tip: open in ChatGPT’s browser or Chrome with WebMCP enabled to drive it with your own prompts.</p>
      </>
    </Dialog>
  );
}
