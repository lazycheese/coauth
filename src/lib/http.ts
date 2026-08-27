// Every network call an agent triggers has to end, one way or another.
//
// A tool that never settles is worse than one that fails: the agent has nothing
// to react to, no error to report to the clinician, and no reason to stop
// waiting. A cold start or a dropped connection should surface as a result the
// caller can act on, so each request is given a deadline.

export const DEFAULT_TIMEOUT_MS = 8000;

export class RequestTimeout extends Error {
  constructor(url: string, ms: number) {
    super(`Request to ${url} did not respond within ${ms}ms`);
    this.name = "RequestTimeout";
  }
}

/** fetch with a deadline. Rejects with RequestTimeout rather than hanging. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;

  // The deadline is enforced here rather than delegated. Aborting the request
  // asks the transport to give up; racing a timer guarantees this call settles
  // even if the transport does not honour that request.
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new RequestTimeout(url, timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([fetch(url, { ...init, signal: controller.signal }), deadline]);
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new RequestTimeout(url, timeoutMs);
    }
    throw e;
  } finally {
    clearTimeout(timer!);
  }
}

/** Convenience for the JSON endpoints, which is all of them here. */
export async function postJson(
  url: string,
  body: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<{ ok: boolean; status: number; json: any }> {
  const res = await fetchWithTimeout(
    url,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    timeoutMs
  );
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* an empty or non-JSON body is reported through status alone */
  }
  return { ok: res.ok, status: res.status, json };
}
