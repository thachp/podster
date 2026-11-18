import { notFound } from "next/navigation";
import { ReadFailure } from "@/components/shell/read-failure";
import { gatewayQuery, requireSession } from "@/lib/gateway/server";
import { AGENT_ID, type PairingView } from "../model";
import { ConfirmPairing } from "./confirm-pairing";

export const metadata = { title: "Confirm Runner · Podster" };

/**
 * The starter's confirmation of a Runner pairing (M7 step 5(c)): the agent's name and the key's thumbprint, from the
 * gateway's read, never the code. Confirming goes back through the gateway's activate, where the API rechecks the person's
 * authority and the plugin's binding. Anyone else, and a session that doesn't exist, gets the same not-found.
 */
export default async function Page({ params }: { params: Promise<{ agent: string }> }) {
  const { agent } = await params;
  if (!AGENT_ID.test(agent)) notFound();
  await requireSession(`/pairing/${agent}`);
  const result = await gatewayQuery<PairingView>(`/api/pairing/${agent}`);
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">Confirm Runner</h1>
      {result.ok ? (
        <ConfirmPairing initial={result.data} />
      ) : result.status === 429 || result.status >= 500 ? (
        <ReadFailure />
      ) : (
        <p>This pairing isn&apos;t yours, or it no longer exists.</p>
      )}
    </section>
  );
}
