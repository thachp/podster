import { ReadFailure } from "@/components/shell/read-failure";
import { gatewayQuery, requireSession } from "@/lib/gateway/server";
import { ClaimForm, type ClaimChoices } from "./claim-form";

export const metadata = { title: "Confirm ownership · Podster" };

/**
 * The Agent Auth plugin's link is `/claim?agent_id=...&code=...` (docs/adr/0001 says why). Middleware moves both into a
 * cookie for this path before the page runs (lib/claim-link.ts), so this page's URL, sign-in's `next` and the read below
 * carry no code. The read forwards the cookie, and the gateway takes the link from it.
 */
export default async function Page() {
  await requireSession("/claim");
  const result = await gatewayQuery<ClaimChoices>("/api/claim");
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">Confirm ownership</h1>
      {result.ok ? (
        <ClaimForm choices={result.data} />
      ) : result.status === 429 || result.status >= 500 ? (
        <ReadFailure />
      ) : result.status === 403 ? (
        <p>You need to be an admin of an organization to connect an agent.</p>
      ) : (
        // Fixed text, and the same for a wrong code and a missing agent, so a link learns nothing and adds nothing.
        <p>This link isn't valid or has expired. Ask the agent for a new one.</p>
      )}
    </section>
  );
}
