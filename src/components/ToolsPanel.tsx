import { useState } from "react";
import { tools } from "../mcp/registerTools";

type Cat = "read" | "write" | "gated";
const categorize = (name: string, readOnly: boolean): Cat =>
  name === "submit" ? "gated" : readOnly ? "read" : "write";

const LABEL: Record<Cat, string> = {
  read: "read-only · auto",
  write: "writes state",
  gated: "human-gated",
};

export function ToolsPanel() {
  const [open, setOpen] = useState(false);
  const groups: Record<Cat, string[]> = { read: [], write: [], gated: [] };
  for (const t of tools) groups[categorize(t.name, t.readOnlyHint)].push(t.name);

  return (
    <div className="tools-panel" data-testid="tools-panel">
      <button className="tools-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? "Hide" : "Show"} WebMCP tools and permissions ({tools.length})
      </button>
      {open && (
        <div className="tools-body">
          <p className="tools-note">
            Page declares a <code>tools</code> Permissions-Policy (default <code>self</code>). Write tools change
            page state; <strong>submit is human-gated</strong> and cannot run without a clinician signature.
          </p>
          {(["read", "write", "gated"] as Cat[]).map((cat) => (
            <div key={cat} className="tools-group">
              <span className={`tools-badge tb-${cat}`}>{LABEL[cat]}</span>
              <span className="tools-list">{groups[cat].join(", ")}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
