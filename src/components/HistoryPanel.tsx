import { useCoAuth } from "../store/coauthStore";

export function HistoryPanel() {
  const history = useCoAuth((s) => s.history);
  if (history.length === 0) return null;
  return (
    <div className="history-panel" data-testid="history-panel">
      <p className="muted history-title">Submitted ({history.length})</p>
      {history.slice(0, 6).map((h) => (
        <div className="history-row" key={h.confirmationId}>
          <span className="history-id">{h.confirmationId}</span>
          <span className="history-meta">{h.patientName} · {h.payer}</span>
          <span className={`history-risk ${h.riskAtSubmit >= 55 ? "hr-high" : h.riskAtSubmit >= 28 ? "hr-mod" : "hr-low"}`}>{h.riskAtSubmit}%</span>
        </div>
      ))}
    </div>
  );
}
