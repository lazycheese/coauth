export function Intro({ onWatch, onClose }: { onWatch: () => void; onClose: () => void }) {
  return (
    <div className="cmp-overlay" data-testid="intro-overlay">
      <div className="intro-modal">
        <div className="intro-mark">CoAuth</div>
        <h1>A prior authorization a clinician and an agent fill out together.</h1>
        <p className="intro-lead">
          About <strong>82% of denied prior authorizations get overturned on appeal</strong>: the decision was
          usually fine, the paperwork was not. CoAuth exposes the payer form to an AI agent as <strong>WebMCP
          tools</strong>, so the agent handles the fields and the checks while the clinician keeps the judgment
          calls and the signature.
        </p>
        <ul className="intro-points">
          <li><strong>12 WebMCP tools.</strong> The agent calls typed functions instead of scraping the page.</li>
          <li><strong>Human-gated submit.</strong> Without a clinician signature, the submit tool returns blocked.</li>
          <li><strong>Catches issues early.</strong> Contraindications, unmet step therapy, and a denial-risk score.</li>
        </ul>
        <div className="intro-actions">
          <button className="btn btn-primary" data-testid="intro-watch" style={{ width: "auto" }} onClick={onWatch}>Play scripted walkthrough (30s)</button>
          <button className="btn" data-testid="intro-close" style={{ width: "auto" }} onClick={onClose}>Explore it myself</button>
        </div>
        <p className="intro-foot muted">Tip: open in ChatGPT’s browser or Chrome with WebMCP enabled to drive it with your own prompts.</p>
      </div>
    </div>
  );
}
