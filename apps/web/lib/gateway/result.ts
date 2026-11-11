/** `retryAfter` is the whole seconds a `rate_limited` answer asked for, when it said. */
export type GatewayResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string; retryAfter?: number; message?: string };

export async function toResult<T>(response: Response): Promise<GatewayResult<T>> {
  const body = await response.json().catch(() => null);
  if (response.ok) return { ok: true, data: body as T };
  const error = (body as { error?: { code?: string; message?: unknown } } | null)?.error;
  const code = error?.code ?? "error";
  // The server's message, kept only where it says more than the code. It's never shown as it is: a screen picks its own
  // sentence, as the merge control does for an approval Podster didn't record.
  const message = typeof error?.message === "string" && error.message !== code ? error.message : undefined;
  const retryAfter = response.headers.get("retry-after");
  const failure = { ok: false as const, status: response.status, code, ...(message ? { message } : {}) };
  return retryAfter && /^\d+$/.test(retryAfter) ? { ...failure, retryAfter: Number(retryAfter) } : failure;
}
