import { useCoAuth } from "../store/coauthStore";

// Whether an interaction came from a person.
//
// The browser is the only thing that can tell. `isTrusted` is true exactly for
// events the user agent generated in response to a real input device, and false
// for anything a script dispatched - and a React handler fires identically for
// both. Any control whose effect is a clinical decision, or whose effect is
// recorded as the clinician's, has to ask.
//
// This lives in one place on purpose. The guard was previously added control by
// control as each one was found, which is how the evidence picker and the
// accept-draft button ended up without it while the field inputs and the
// signature button had it. One helper, one list of call sites, one thing to
// grep for.
//
// What it does not do: stop a script that can drive real input devices, or one
// that waits for a person to act and races them. It draws the line between
// "a script did this by itself" and "a person did this", which is the line the
// audit trail claims to record.

export type GestureEvent = { nativeEvent: { isTrusted: boolean } };

export function isHumanGesture(e: GestureEvent | undefined): boolean {
  return !!e?.nativeEvent?.isTrusted;
}

/** Wrap a handler so it runs only for a real interaction.
 *
 * A refused call is logged rather than dropped silently: a script trying to
 * click the clinician's controls is something the clinician should be able to
 * see in the activity trail afterwards. */
export function humanOnly<E extends GestureEvent>(
  tool: string,
  detail: string,
  handler: (e: E) => void | Promise<void>
): (e: E) => void {
  return (e: E) => {
    if (!isHumanGesture(e)) {
      useCoAuth.getState().logActivity("agent", tool, `REFUSED - ${detail}`);
      return;
    }
    void handler(e);
  };
}
