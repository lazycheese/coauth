import { useEffect, useRef, useState } from "react";
import { useCoAuth } from "../store/coauthStore";
import type { FieldDef } from "../data/seed";
import { RiskMeter } from "./RiskMeter";
import { ConflictAlerts } from "./ConflictAlerts";
import { scanUntrusted } from "../rules/untrusted";
import { humanActions } from "../app/actions";

function FieldRow({ field, flash }: { field: FieldDef; flash: boolean }) {
  const value = useCoAuth((s) => s.formFields[field.id]);
  // Selecting the row's own result rather than scanning the whole list in each
  // row on every render. With a dozen fields this is not a performance problem;
  // it is a habit that becomes one.
  const result = useCoAuth((s) => s.validationByField[field.id]);
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
  const statusLabel =
    status === "ok" ? "complete" : status === "invalid" ? "filled but not valid" : status === "judgment" ? "awaiting clinician" : "not filled";
  const docs = useCoAuth((s) => s.docs);
  const attach = useCoAuth((s) => s.attach);
  const [picking, setPicking] = useState(false);
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
    // The picker lives with the field rather than in another panel, so it can
    // be reached with the keyboard and does not require crossing the page.
    return (
      <div className={`field field-${status} ${flash ? "field-flash" : ""}`} data-testid={`field-${field.id}`}>
        <span className="field-label" id={`${field.id}-label`}>
          {field.label}
          {ProvBadge}
        </span>
        <button
          type="button"
          className={`evidence-slot ${value ? "attached" : ""}`}
          aria-labelledby={`${field.id}-label`}
          aria-expanded={picking}
          aria-describedby={`${field.id}-state`}
          onClick={() => { setFocused(field.id); setPicking((p) => !p); }}
        >
          <span id={`${field.id}-state`}>
            {value ? (docLabel ?? String(value)) : "No evidence attached. Choose a document."}
          </span>
        </button>
        {picking && (
          <ul className="evidence-picker" data-testid={`picker-${field.id}`} aria-label={`Documents for ${field.label}`}>
            {docs.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  className="doc"
                  data-testid={`pick-${field.id}-${d.id}`}
                  onClick={() => {
                    attach(field.id, d.id);
                    runValidation();
                    logActivity("human", "attach_evidence", `${d.id} -> ${field.id}`);
                    setPicking(false);
                  }}
                >
                  {d.label}
                  {!scanUntrusted(d.content).clean && (
                    <span className="doc-flag">contains instruction-like text, treated as data</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
        <span className={`field-status status-${status}`} role="img" aria-label={`Status: ${statusLabel}`} />
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
      <span className={`field-status status-${status}`} role="img" aria-label={`Status: ${statusLabel}`} />
    </div>
  );
}

/** Cases worth starting from, described by what each one demonstrates rather
 * than by who is in it. Someone opening this cold needs to know why they would
 * pick one. */
const STARTERS = [
  {
    patientId: "jane-doe",
    payer: "uhc",
    who: "Jane Doe, UnitedHealthcare",
    shows: "A request that meets the criteria. Fills cleanly and reaches signature.",
  },
  {
    patientId: "marcus-lee",
    payer: "aetna",
    who: "Marcus Lee, Aetna",
    shows: "A positive TB screen and a short drug trial. Submission is blocked until the clinician overrides it.",
  },
  {
    patientId: "ana-torres",
    payer: "aetna",
    who: "Ana Torres, Aetna",
    shows: "Etanercept against a payer file that covers adalimumab only. Exercises drug coverage.",
  },
];

function ValidationBar() {
  const v = useCoAuth((s) => s.validation);
  const fail = v?.failCount ?? 0;
  const invalid = v?.invalidCount ?? 0;
  // failCount includes filled-but-invalid fields; a wrong code is not "missing".
  const missing = Math.max(0, fail - invalid);
  const judgment = v?.judgmentCount ?? 0;
  const issues = fail + judgment;
  const tone = fail > 0 ? "red" : judgment > 0 ? "amber" : "green";
  const parts = [
    missing > 0 ? `${missing} missing` : "",
    invalid > 0 ? `${invalid} invalid` : "",
    judgment > 0 ? `${judgment} need clinician judgment` : "",
  ].filter(Boolean);
  return (
    <div
      className={`validation-bar tone-${tone}`}
      role="status"
      aria-live="polite"
      data-testid="validation-bar"
      data-issues={issues}
      data-missing={missing}
      data-invalid={invalid}
    >
      {issues === 0 ? (
        <strong>All requirements met - ready for clinician signature</strong>
      ) : (
        <>
          <strong>{issues} open</strong>
          <span>{parts.join(" · ")}</span>
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
        <p className="empty-title">No active prior authorization.</p>
        <p className="muted">
          With a WebMCP agent, ask it to start one: “Start a prior auth for Jane Doe’s Humira request with
          UnitedHealthcare.” Without one, pick a case below and drive it yourself.
        </p>
        <ul className="starters">
          {STARTERS.map((c) => (
            <li key={c.patientId + c.payer}>
              <button
                type="button"
                className="starter"
                data-testid={`start-${c.patientId}`}
                onClick={async () => {
                  await humanActions.loadPatient(c.patientId);
                  await humanActions.choosePayer(c.payer);
                }}
              >
                <span className="starter-who">{c.who}</span>
                <span className="starter-why">{c.shows}</span>
              </button>
            </li>
          ))}
        </ul>
        <p className="muted small">
          Press Cmd K, or Ctrl K, at any point for the tools an agent would call.
        </p>
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
