import { useRef, useState } from "react";
import { SubmissionForm } from "./components/SubmissionForm";
import { AgentPanel } from "./components/AgentPanel";
import { PatientPanel } from "./components/PatientPanel";
import { Compare } from "./components/Compare";
import { AppealModal } from "./components/AppealModal";
import { Intro } from "./components/Intro";
import { Toast } from "./components/Toast";
import { CommandPalette } from "./components/CommandPalette";
import { useCoAuth } from "./store/coauthStore";
import { tools } from "./mcp/registerTools";
import { runDemo, type DemoHandle } from "./demo/runner";
import { beginScriptedRun, endScriptedRun } from "./app/scriptedRun";
import { useUnsavedGuard } from "./lib/useUnsavedGuard";

function TopBar({ onCompare, onDemo, demoRunning }: { onCompare: () => void; onDemo: () => void; demoRunning: boolean }) {
  const toolCount = tools.length;
  const webmcp = useCoAuth((s) => s.webmcpConnected);
  const payer = useCoAuth((s) => s.payerRules?.name);
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-name">CoAuth</span>
        <span className="brand-sub">agent-native prior authorization</span>
      </div>
      <div className="topbar-right">
        {payer && <span className="pill pill-ctx">{payer}</span>}
        <span className="pill pill-kbd" title="Command palette">Cmd K</span>
        <button className="pill pill-demo" data-testid="watch-demo" onClick={onDemo} disabled={demoRunning} title="A scripted, canned run of the human and agent flow (not a live agent)">
          {demoRunning ? "Running" : "Scripted walkthrough"}
        </button>
        <button className="pill pill-compare" data-testid="open-compare" onClick={onCompare}>Compare vs baseline</button>
        <span className={`pill ${webmcp ? "pill-live" : "pill-idle"}`} data-testid="webmcp-status">
          {webmcp ? `WebMCP connected · ${toolCount} tools` : `WebMCP ready · ${toolCount} tools`}
        </span>
      </div>
    </header>
  );
}

export function App() {
  const [compare, setCompare] = useState(false);
  const [intro, setIntro] = useState(true);
  const [caption, setCaption] = useState<string | null>(null);
  const [demoRunning, setDemoRunning] = useState(false);
  const handleRef = useRef<DemoHandle | null>(null);
  useUnsavedGuard();

  const startDemo = async () => {
    const handle: DemoHandle = { cancelled: false };
    handleRef.current = handle;
    // Takes over from anything already driving the workspace, and gives up if
    // something else takes over from it.
    beginScriptedRun("walkthrough", () => {
      handle.cancelled = true;
      setDemoRunning(false);
    });
    setDemoRunning(true);
    try {
      await runDemo((c) => setCaption(c), handle);
    } catch {
      /* cancelled by another run */
    } finally {
      endScriptedRun("walkthrough");
      setDemoRunning(false);
      // Clearing the caption here rather than in the cancel callback: a step
      // already in flight would otherwise write its caption back afterwards.
      if (handle.cancelled) setCaption(null);
    }
  };

  return (
    <div className="app">
      <TopBar onCompare={() => setCompare(true)} onDemo={startDemo} demoRunning={demoRunning} />
      {caption && (
        <div className="demo-caption" data-testid="demo-caption" onClick={() => setCaption(null)}>
          {caption}
        </div>
      )}
      {intro && (
        <Intro
          onWatch={() => { setIntro(false); startDemo(); }}
          onClose={() => setIntro(false)}
        />
      )}
      <AppealModal />
      <Toast />
      <CommandPalette />
      {compare && <Compare onClose={() => setCompare(false)} />}
      <div className="app-shell">
        <section data-testid="patient-panel" className="col col-left">
          <h2>Patient &amp; Evidence</h2>
          <PatientPanel />
        </section>
        <section data-testid="submission-form" className="col col-center">
          <SubmissionForm />
        </section>
        <section data-testid="agent-panel" className="col col-right">
          <h2>Agent</h2>
          <AgentPanel />
        </section>
      </div>
    </div>
  );
}
