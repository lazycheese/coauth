import { ActivityLog } from "./ActivityLog";
import { ReviewSign } from "./ReviewSign";
import { ToolsPanel } from "./ToolsPanel";

export function AgentPanel() {
  return (
    <div className="agent-panel">
      <ReviewSign />
      <ActivityLog />
      <ToolsPanel />
    </div>
  );
}
