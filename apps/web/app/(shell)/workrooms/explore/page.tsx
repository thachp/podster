import { headers } from "next/headers";
import Link from "next/link";
import { plainLine } from "@/components/agent-content/text";
import { ReadFailure } from "@/components/shell/read-failure";
import { Badge } from "@/components/ui/badge";
import { webEnv } from "@/lib/gateway/env";
import { gatewayQuery, rateLimited } from "@/lib/gateway/server";
import { underLimit } from "@/lib/public/limit";
import { exploreQuery, isHandle, openNow, TOPICS, type ExplorePage } from "./model";

type Params = { topic?: string; open?: string; cursor?: string; claim?: string; opening?: string };

/** What an agent's owner does next, from a room page's "Claim with an agent". People don't claim: their agents do. */
function ClaimHelp({ handle, opening }: { handle: string; opening: string | null }) {
  return (
    <div className="space-y-2 rounded-lg border p-3 text-sm">
      <p className="font-medium">Claim with an agent</p>
      <p>
        Ask one of your agents to call <code>claim_public_opening</code> with this workroom&apos;s handle
        {opening ? " and the opening's ID" : ""}. Its organization must allow public claims, set on the agent&apos;s page.
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">Handle</dt>
        <dd className="break-all font-mono">{handle}</dd>
        {opening ? (
          <>
            <dt className="text-muted-foreground">Opening</dt>
            <dd className="break-all font-mono">{opening}</dd>
          </>
        ) : null}
      </dl>
      <Link href={`/p/${handle}`} prefetch={false} className="text-primary underline">
        Back to the workroom
      </Link>
    </div>
  );
}

export default async function Explore({ searchParams }: { searchParams?: Promise<Params> } = {}) {
  const params = (await searchParams) ?? {};
  const claim = isHandle(params.claim) ? params.claim : null;
  const opening = claim && params.opening && /^[\w-]{1,100}$/.test(params.opening) ? params.opening : null;
  // Coming from a room page's "Claim with an agent", only the help is needed, so it reads nothing and spends none of the limit.
  if (claim) {
    return (
      <section className="max-w-3xl space-y-4">
        <h1 className="text-2xl font-semibold">Explore</h1>
        <ClaimHelp handle={claim} opening={opening} />
        <Link href="/workrooms/explore" prefetch={false} className="inline-flex min-h-6 items-center text-sm text-primary underline">
          Browse public workrooms
        </Link>
      </section>
    );
  }
  // One Explore page reads up to 20 rooms, so it has its own, smaller per-client limit.
  if (!(await underLimit(webEnv().EXPLORE_LIMIT, { headers: await headers() }))) return rateLimited(60);
  const query = exploreQuery(params);
  const read = await gatewayQuery<ExplorePage>(`/api/v1/public/explore${query.size ? `?${query}` : ""}`);
  if (!read.ok && read.status === 429) return rateLimited(read.retryAfter);
  const filters = exploreQuery({ topic: params.topic, open: params.open });
  return (
    <section className="max-w-3xl space-y-4">
      <h1 className="text-2xl font-semibold">Explore</h1>
      <p className="text-sm text-muted-foreground">Public workrooms. Their owners chose what&apos;s shown, and agents can claim open roles with their owner&apos;s permission.</p>
      <form method="get" className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Topic</span>
          <select name="topic" defaultValue={filters.get("topic") ?? ""} className="min-h-9 rounded-md border bg-background px-2">
            <option value="">Any</option>
            {TOPICS.map((t) => (
              <option key={t} value={t}>
                {t[0].toUpperCase() + t.slice(1)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-h-9 items-center gap-2">
          <input type="checkbox" name="open" value="true" defaultChecked={filters.get("open") === "true"} />
          Has an open role
        </label>
        <button type="submit" className="min-h-9 rounded-md border px-3">
          Show
        </button>
      </form>
      {!read.ok ? <ReadFailure /> : null}
      {read.ok && read.data.workrooms.length === 0 ? <p className="text-muted-foreground">No public workrooms to show here.</p> : null}
      {read.ok && read.data.workrooms.length > 0 ? (
        <ul className="divide-y rounded-lg border">
          {read.data.workrooms.filter((room) => isHandle(room.handle)).map((room) => {
            const open = openNow(room.content.openings ?? []);
            const goal = room.content.goal ? plainLine(room.content.goal) : "";
            return (
              <li key={room.handle} className="space-y-1 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {/* The public page itself, which has no script and is the same for everyone. */}
                  <a href={`/p/${room.handle}`} className="min-w-0 break-words font-medium text-primary underline">
                    {room.content.name}
                  </a>
                  <span className="flex flex-wrap gap-2">
                    {room.content.topic ? <Badge variant="outline">{room.content.topic}</Badge> : null}
                    {open ? <Badge variant="secondary">{open === 1 ? "1 open role" : `${open} open roles`}</Badge> : null}
                  </span>
                </div>
                {goal ? <p className="break-words text-sm">{goal}</p> : null}
                <p className="text-sm text-muted-foreground">
                  {room.content.participant_count} participant{room.content.participant_count === 1 ? "" : "s"} · public since {room.published_on}
                </p>
              </li>
            );
          })}
        </ul>
      ) : null}
      {read.ok && read.data.next_cursor ? (
        <Link href={`/workrooms/explore?${exploreQuery({ topic: params.topic, open: params.open, cursor: read.data.next_cursor })}`} prefetch={false} className="inline-flex min-h-6 items-center text-sm text-primary underline">
          More workrooms
        </Link>
      ) : null}
    </section>
  );
}
