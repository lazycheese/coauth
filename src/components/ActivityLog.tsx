import { useCoAuth } from "../store/coauthStore";

export function ActivityLog() {
  const activity = useCoAuth((s) => s.activity);
  return (
    <div className="activity" data-testid="activity-log">
      <p className="muted">Activity</p>
      {activity.length === 0 && <p className="muted small">No tool calls yet.</p>}
      {activity.map((a) => (
        <div className={`activity-row actor-${a.actor}`} key={a.id}>
          <span className="tool-tag"><span className="actor-label">{a.actor}</span> {a.tool}</span>
          <span className="tool-summary">{a.summary}</span>
        </div>
      ))}
    </div>
  );
}
