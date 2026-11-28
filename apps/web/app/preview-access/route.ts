import { webEnv } from "@/lib/gateway/env";
import { previewAccess } from "@/lib/preview-access";

/**
 * A preview host's way in (M8 step 7): signs the person in if they aren't, asks the gateway for a ticket, and sends the
 * browser on with it in the URL fragment only. The page sets its own headers, `no-store` and `no-referrer` among them,
 * so next.config's rule leaves it out.
 */
export const GET = (request: Request) => previewAccess(request, webEnv().GATEWAY, webEnv().APP_URL);
