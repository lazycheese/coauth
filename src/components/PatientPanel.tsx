import { useCoAuth } from "../store/coauthStore";
import { scanUntrusted } from "../rules/untrusted";
import { HistoryPanel } from "./HistoryPanel";

export function PatientPanel() {
  const patient = useCoAuth((s) => s.patient);
  const docs = useCoAuth((s) => s.docs);

  if (!patient) {
    return (
      <>
        <p className="muted" data-testid="patient-empty">No patient loaded.</p>
        <HistoryPanel />
      </>
    );
  }

  return (
    <div className="patient" data-testid="patient-card">
      <div className="patient-head">
        <strong>{patient.name}</strong>
        <span className="muted">DOB {patient.dob} · {patient.memberId}</span>
      </div>

      <div className="facts">
        <div className="fact"><span className="muted">Diagnosis</span>{patient.diagnoses[0].label} ({patient.diagnoses[0].code})</div>
        <div className="fact"><span className="muted">Prior treatments</span>
          <ul>{patient.medsTried.map((m) => <li key={m.name}>{m.name} - {m.outcome}</li>)}</ul>
        </div>
        <div className="fact"><span className="muted">Labs</span>
          <ul>{patient.labs.map((l) => <li key={l.name}>{l.name}: {l.value} <span className="muted">({l.date})</span></li>)}</ul>
        </div>
      </div>

      <div className="evidence">
        <p className="muted" id="evidence-heading">Documents on file</p>
        <p className="muted small">Attach one from the evidence field it belongs to.</p>
        {docs.map((d) => (
          <div key={d.id} className="doc doc-static" data-testid={`doc-${d.id}`}>
            {d.label}
            {!scanUntrusted(d.content).clean && (
              <span className="doc-flag" data-testid={`doc-flag-${d.id}`}>
                contains instruction-like text, treated as data
              </span>
            )}
          </div>
        ))}
      </div>

      <HistoryPanel />
    </div>
  );
}
