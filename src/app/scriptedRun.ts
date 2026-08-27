import { useCoAuth } from "../store/coauthStore";

// Only one scripted run at a time.
//
// The walkthrough and the comparison both drive the workspace on a timer. Left
// alone they will interleave, and the comparison in particular claims to be a
// controlled measurement against one patient and one payer. A second flow
// writing fields underneath it does not make the numbers look wrong, it makes
// them quietly untrue, which is worse.
//
// Starting a run cancels whatever was running before it, so there is always
// exactly one thing driving the workspace.

export type RunName = "walkthrough" | "comparison";

let active: { name: RunName; cancel: () => void } | null = null;

export function beginScriptedRun(name: RunName, cancel: () => void) {
  active?.cancel();
  active = { name, cancel };
  useCoAuth.getState().setScriptedRun(name);
}

export function endScriptedRun(name: RunName) {
  if (active?.name !== name) return; // a newer run has already taken over
  active = null;
  useCoAuth.getState().setScriptedRun(null);
}

export function activeScriptedRun(): RunName | null {
  return active?.name ?? null;
}
