/** `retryAfter` is the whole seconds a `rate_limited` answer asked for, when it said. */
export type GatewayResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string; retryAfter?: number };

export async function toResult<T>(response: Response): Promise<GatewayResult<T>> {
  const body = await response.json().catch(() => null);
  if (response.ok) return { ok: true, data: body as T };
  const code = (body as { error?: { code?: string } } | null)?.error?.code ?? "error";
  const retryAfter = response.headers.get("retry-after");
  return retryAfter && /^\d+$/.test(retryAfter) ? { ok: false, status: response.status, code, retryAfter: Number(retryAfter) } : { ok: false, status: response.status, code };
}
