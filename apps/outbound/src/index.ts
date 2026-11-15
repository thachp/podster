// The outbound Worker's entry (M6 stage 1, ADR 0010's revision). It has no binding, no variable and no secret, and
// it takes no argument: the request, the environment and the context are never read. Every call is refused.
import { refuse } from "./refuse";

export default {
  fetch(): Response {
    return refuse();
  },
} satisfies ExportedHandler;
