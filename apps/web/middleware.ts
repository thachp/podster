import { NextResponse, type NextRequest } from "next/server";
import { claimLinkMoved } from "./lib/claim-link";

/** Layouts can't see the URL, and sign-in needs it to come back. Set here, so a client's own value never counts. */
export function middleware(request: NextRequest) {
  // An approval link's code leaves the URL before anything reads the path, sign-in's `next` included.
  const moved = claimLinkMoved(request.nextUrl, request.method);
  if (moved) return moved;
  const headers = new Headers(request.headers);
  headers.set("x-podster-path", request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: ["/((?!api/|_next/).*)"] };
