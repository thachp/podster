import { RATE_LIMITED_PATH, secondsToWait } from "@/lib/gateway/server";
import { safeNext } from "@/lib/safe-next";
import { WaitThenRetry } from "./wait-then-retry";

export const metadata = { title: "Too many requests · Podster" };

const one = (value: string | string[] | undefined) => (typeof value === "string" ? value : undefined);

/**
 * Where a page goes when a read it can't do without was refused for the person's rate limit. It reads nothing from the
 * gateway, so it can't be refused itself. `after` and `next` come from the URL, so both are checked again: a wait is whole
 * seconds and capped, and the way back is a path on this host.
 */
export default async function TooManyRequests({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const wait = secondsToWait(one(query.after));
  const back = safeNext(one(query.next));
  return (
    <main id="main-content" tabIndex={-1} className="mx-auto max-w-lg space-y-3 p-8 outline-none">
      <h1 className="text-2xl font-semibold">Too many requests just now</h1>
      <p className="text-muted-foreground">Podster limits how often one person can load pages, so this one didn&apos;t load. Nothing you did was lost or changed.</p>
      <WaitThenRetry seconds={wait} href={back.startsWith(RATE_LIMITED_PATH) ? "/attention" : back} />
    </main>
  );
}
