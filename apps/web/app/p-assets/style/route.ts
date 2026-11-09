import { publicResponse } from "@/lib/public/headers";
import { STYLESHEET } from "@/lib/public/render";

/** The public room page's stylesheet: its CSP allows no inline style. */
export function GET() {
  return publicResponse(STYLESHEET, 200, "text/css; charset=utf-8");
}
