import { webEnv } from "@/lib/gateway/env";
import { forwardUpload } from "@/lib/uploads/forward";

export const PUT = (request: Request) => forwardUpload(request, webEnv().GATEWAY, webEnv().APP_URL);
