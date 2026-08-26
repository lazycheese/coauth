import { useEffect, useRef, useState } from "react";
import { useCoAuth } from "../store/coauthStore";
import type { FieldDef } from "../data/seed";
import { RiskMeter } from "./RiskMeter";
import { ConflictAlerts } from "./ConflictAlerts";

function FieldRow({ field, flash }: { field: FieldDef; flash: boolean }) {
  const value = useCoAuth((s) => s.formFields[field.id]);
  const result = useCoAuth((s) => s.validation?.results.find((r) => r.fieldId === field.id));
  const setField = useCoAuth((s) => s.setField);
  const setFocused = useCoAuth((s) => s.setFocused);
  const runValidation = useCoAuth((s) => s.runValidation);

  const docLabel = useCoAuth((s) => s.docs.find((d) => d.id === value)?.label);
  const suggestion = useCoAuth((s) => s.suggestions[field.id]);
  const acceptSuggestion = useCoAuth((s) => s.acceptSuggestion);
  const setProvenance = useCoAuth((s) => s.setProvenance);
  const prov = useCoAuth((s) => s.provenance[field.id]);
  const logActivity = useCoAuth((s) => s.logActivity);
  const status = result?.ok ? "ok" : result?.invalid ? "invalid" : field.requiresHumanJudgment ? "judgment" : "missing";
  const edit = (v: string) => {
    setField(field.id, v);
    setProvenance(field.id, { by: "clinician" });
    runValidation();
  };
  const ProvBadge = prov && value ? (
    prov.by === "clinician" ? (
      <span className="prov prov-clinician" data-testid={`prov-${field.id}`}>clinician</span>
    ) : prov.verified ? (
      <span className="prov prov-verified" data-testid={`prov-${field.id}`} title={`Matches ${prov.source}`}>verified from chart</span>
    ) : (
      <span className="prov prov-unverified" data-testid={`prov-${field.id}`} title="Not matched against a chart value">agent-entered</span>
    )
  ) : null;

  if (field.type === "evidence") {
    return (
      <div className={`field field-${status} ${flash ? "field-flash" : ""}`} data-testid={`field-${field.id}`}>
        <label>
          <span className="field-label">{field.label}</span>
          <div className={`evidence-slot ${value ? "attached" : ""}`} tabIndex={0} onFocus={() => setFocused(field.id)} onClick={() => setFocused(field.id)}>
            {value ? <>{docLabel ?? String(value)}</> : <span className="muted">No evidence attached. Focus this field, then pick a document.</span>}
          </div>
        </label>
        <span className={`field-status status-${status}`} aria-label={status} />
      </div>
    );
  }

  return (
    <div className={`field field-${status} ${flash ? "field-flash" : ""}`} data-testid={`field-${field.id}`}>
      <label>
        <span className="field-label">
          {field.label}
          {field.requiresHumanJudgment && <span className="chip chip-judgment">clinician</span>}
          {ProvBadge}
        </span>
        {field.type === "select" ? (
          <select
            value={(value as string) ?? ""}
            onFocus={() => setFocused(field.id)}
            onChange={(e) => edit(e.target.value)}
          >
            <option value="">-</option>
            {field.options?.map((o) => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
        ) : field.type === "longtext" ? (
          <textarea
            rows={2}
            value={(value as string) ?? ""}
            onFocus={() => setFocused(field.id)}
            onChange={(e) => edit(e.target.value)}
          />
        ) : (
          <input
            type="text"
            value={(value as string) ?? ""}
            onFocus={() => setFocused(field.id)}
            onChange={(e) => edit(e.target.value)}
          />
        )}
      </label>
      {result?.invalid && result.reason && (
        <div className="field-error" data-testid={`field-error-${field.id}`}>{result.reason}</div>
      )}
      {suggestion && (
        <div className="draft-card" data-testid={`draft-${field.id}`}>
          <div className="draft-head">Agent draft. Review before accepting.</div>
          <div className="draft-text">{suggestion}</div>
          <div className="draft-actions">
            <button
              className="btn btn-mini"
              data-testid={`accept-draft-${field.id}`}
              onClick={() => {
                acceptSuggestion(field.id);
                logActivity("human", "accept_draft", `Accepted agent draft for ${field.id}`);
              }}
            >
              Accept &amp; edit
            </button>
          </div>
        </div>
      )}
      <span className={`field-status status-${status}`} aria-label={status} />
    </div>
  );
}

function ValidationBar() {
  const v = useCoAuth((s) => s.validation);
  const fail = v?.failCount ?? 0;
  const judgment = v?.judgmentCount ?? 0;
  const issues = fail + judgment;
  const tone = fail > 0 ? "red" : judgment > 0 ? "amber" : "green";
  return (
    <div className={`validation-bar tone-${tone}`} data-testid="validation-bar" data-issues={issues}>
      {issues === 0 ? (
        <strong>All requirements met - ready for clinician signature</strong>
      ) : (
        <>
          <strong>{issues} open</strong>
          <span>{fail} missing · {judgment} need clinician judgment</span>
        </>
      )}
    </div>
  );
}

export function SubmissionForm() {
  const rules = useCoAuth((s) => s.payerRules);
  const formFields = useCoAuth((s) => s.formFields);
  const prev = useRef<Record<string, unknown>>({});
  const [flash, setFlash] = useState<Set<string>>(new Set());

  useEffect(() => {
    const changed: string[] = [];
    for (const k of Object.keys(formFields)) {
      if (prev.current[k] !== formFields[k]) changed.push(k);
    }
    prev.current = { ...formFields };
    if (changed.length) {
      setFlash(new Set(changed));
      const id = setTimeout(() => setFlash(new Set()), 700);
      return () => clearTimeout(id);
    }
  }, [formFields]);

  if (!rules) {
    return (
      <div className="empty-state" data-testid="form-empty">
        <p>No active prior authorization.</p>
        <p className="muted">Ask the agent to start one, e.g. “Start a prior auth for Jane Doe’s Humira request with UnitedHealthcare.”</p>
      </div>
    );
  }

  return (
    <div className="submission">
      <div className="submission-title">Prior Authorization Request</div>
      <RiskMeter />
      <ConflictAlerts />
      <ValidationBar />
      <div className="payer-tag">{rules.name} · {rules.drug}</div>
      <div className="fields">
        {rules.requiredFields.map((f) => (
          <FieldRow key={f.id} field={f} flash={flash.has(f.id)} />
        ))}
      </div>
    </div>
  );
}
