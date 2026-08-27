import { useEffect, useState } from "react";

/** Whether this person has asked for less movement.
 *
 * A CSS rule can neutralise CSS animation, but it cannot reach a value being
 * tweened in JavaScript. Anything animating from script has to ask for itself,
 * so the reduced-motion setting is honoured rather than only appearing to be. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });

  useEffect(() => {
    if (!window.matchMedia) return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return reduced;
}
