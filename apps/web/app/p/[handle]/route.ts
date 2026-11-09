import { webEnv } from "@/lib/gateway/env";
import { publicResponse } from "@/lib/public/headers";
import { underLimit } from "@/lib/public/limit";
import { limitedPage, notFoundPage, roomPage, type PublicView } from "@/lib/public/render";

/**
 * `GET /p/{handle}`: a public room's page, for anyone, signed in or not (M4 step 11(b), ADR 0008). It's built from the view
 * the gateway's PublicReads entrypoint gives, with no script and nothing about who is asking, so every viewer gets the same
 * bytes. Every way a handle can fail answers the same not-found page.
 */
export async function GET(request: Request, context: { params: Promise<{ handle: string }> }) {
  const env = webEnv();
  if (!(await underLimit(env.PUBLIC_PAGE_LIMIT, request.headers.get("cf-connecting-ip")))) {
    return publicResponse(limitedPage(), 429, undefined, [["Retry-After", "60"]]);
  }
  const { handle } = await context.params;
  if (!env.PUBLIC_READS) return publicResponse(notFoundPage(), 404);
  let answer;
  try {
    answer = await env.PUBLIC_READS.getWorkroom(handle);
  } catch {
    // The gateway couldn't answer. It's no different from a room that isn't public, so nothing is told apart.
    console.error("public page read failed");
    return publicResponse(notFoundPage(), 404);
  }
  if (answer.status !== 200 || (answer.view as { handle?: unknown }).handle !== handle) return publicResponse(notFoundPage(), 404);
  return publicResponse(roomPage(answer.view as unknown as PublicView), 200);
}
