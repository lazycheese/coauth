import { useEffect } from "react";
import { useCoAuth } from "../store/coauthStore";

/** Warn before leaving with a part-finished authorization on screen.
 *
 * Nothing about a submission is persisted, on purpose: keeping a patient's
 * details in browser storage is a habit worth not forming. The cost of that
 * choice is that a reload discards the work, so the person doing it should be
 * asked first rather than finding out afterwards.
 *
 * The prompt only appears when there is something to lose: fields filled in,
 * and nothing submitted since. A reviewer clicking through an empty form is
 * never interrupted. */
export function useUnsavedGuard() {
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const s = useCoAuth.getState();
      const filled = Object.values(s.formFields).some((v) => String(v ?? "").trim() !== "");
      const alreadySubmitted = s.submitResult?.status === "submitted";
      if (!filled || alreadySubmitted) return;
      e.preventDefault();
      // Browsers show their own wording; returning a value is what marks the
      // event as needing confirmation.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);
}
