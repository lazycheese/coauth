import { useCallback, useEffect, useState } from "react";
import { postJson } from "./http";
import { useCoAuth } from "../store/coauthStore";

export interface Clinician {
  id: string;
  name: string;
  npi?: string;
  role: string;
}

export interface SessionState {
  status: "loading" | "anonymous" | "authenticated" | "unavailable";
  clinician: Clinician | null;
  /** Who this deployment will authenticate, for the sign-in control. */
  directory: Clinician[];
  error: string | null;
}

/** The clinician session.
 *
 * Deliberately thin: the session itself lives in an HttpOnly cookie the page
 * cannot read, so this holds only what the server chose to tell us about it.
 * Nothing here is a security control - the server re-reads the cookie on every
 * request that matters. It exists so the interface can show the right panel. */
export function useSession() {
  const [state, setState] = useState<SessionState>({
    status: "loading",
    clinician: null,
    directory: [],
    error: null,
  });

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/session", { credentials: "same-origin" });
      const json = await res.json();
      if (json?.status === "authenticated") {
        setState({ status: "authenticated", clinician: json.clinician, directory: [], error: null });
      } else {
        setState({ status: "anonymous", clinician: null, directory: json?.clinicians ?? [], error: null });
      }
    } catch {
      setState({ status: "unavailable", clinician: null, directory: [], error: "The session service could not be reached." });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signIn = useCallback(
    async (clinicianId: string, passphrase: string): Promise<string | null> => {
      try {
        const res = await postJson("/api/v1/login", { clinicianId, passphrase });
        if (!res.ok || res.json?.status !== "authenticated") {
          return res.json?.error?.message ?? "Sign-in was refused.";
        }
        setState({ status: "authenticated", clinician: res.json.clinician, directory: [], error: null });
        return null;
      } catch {
        return "The sign-in service could not be reached.";
      }
    },
    []
  );

  const signOut = useCallback(async () => {
    try {
      await fetch("/api/v1/session", { method: "DELETE", credentials: "same-origin" });
    } catch {
      /* the cookie expires on its own; refreshing tells us what actually happened */
    }
    // An approval belongs to the clinician who signed it. Leaving it in place
    // after they sign out left the submit button live with nobody on screen.
    useCoAuth.getState().clearApproval();
    await refresh();
  }, [refresh]);

  return { ...state, signIn, signOut, refresh };
}
