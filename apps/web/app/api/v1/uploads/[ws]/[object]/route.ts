import { webEnv } from "@/lib/gateway/env";
import { withSecurityHeaders } from "@/lib/security-headers";
import { forwardUpload } from "@/lib/uploads/forward";

export const PUT = async (request: Request) => withSecurityHeaders(await forwardUpload(request, webEnv().GATEWAY, webEnv().APP_URL));
