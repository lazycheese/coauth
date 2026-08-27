import { useEffect, useRef, useState } from "react";
import { useCoAuth } from "../store/coauthStore";
import { tools } from "../mcp/registerTools";

const draftAppealTool = () => tools.find((t) => t.name === "draft_appeal")!;

export function RiskMeter() {
  const risk = useCoAuth((s) => s.risk);
  const target = risk?.score ?? null;
  const [display, setDisplay] = useState(target ?? 0);
  const raf = useRef<number>();

  useEffect(() => {
    if (target == null) return;
    const from = display;
    const start = performance.now();
    const dur = 550;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(Math.round(from + (target - from) * eased));
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  if (target == null) return null;
  const band = risk!.band;

  return (
    <div className={`risk-meter band-${band}`} data-testid="risk-meter" data-score={target}>
      <div className="risk-head">
        <span className="risk-label">Denial risk</span>
        <span className="risk-score" data-testid="risk-score">{display}%</span>
      </div>
      <div className="risk-track">
        <div className="risk-fill" style={{ width: `${display}%` }} />
      </div>
      <div className="risk-band-row">
        <div className="risk-band">{band === "high" ? "High - likely denial" : band === "moderate" ? "Moderate" : "Low - likely approval"}</div>
        {band !== "low" && (
          <button className="btn btn-mini appeal-btn" data-testid="draft-appeal-btn" onClick={() => draftAppealTool().execute({}, { actor: "human" })}>
            Draft appeal letter
          </button>
        )}
      </div>
      {risk!.factors.length > 0 && (
        <ul className="risk-factors">
          {risk!.factors.map((f, i) => (
            <li key={i} className={`sev-${f.severity}`}>
              <span>{f.label}</span>
              <span className="risk-pts">+{f.points}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
