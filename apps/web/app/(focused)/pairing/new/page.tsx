import { webEnv } from "@/lib/gateway/env";
import { requireSession } from "@/lib/gateway/server";
import { StartPairing } from "./start-pairing";

export const metadata = { title: "Pair Runner · Podster" };

/** A person starts pairing Runner for a new agent in the organization they act in (M7 step 5). The gateway decides. */
export default async function Page() {
  await requireSession("/pairing/new");
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">Pair Runner</h1>
      <StartPairing gateway={webEnv().GATEWAY_URL} />
    </section>
  );
}
