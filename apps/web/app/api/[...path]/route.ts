import { webEnv } from "@/lib/gateway/env";
import { forwardToGateway } from "@/lib/gateway/forward";
import { withSecurityHeaders } from "@/lib/security-headers";

const forward = async (request: Request) => withSecurityHeaders(await forwardToGateway(request, webEnv().GATEWAY, webEnv().APP_URL));

export { forward as GET, forward as POST, forward as PUT, forward as DELETE, forward as PATCH };
