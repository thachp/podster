import Link from "next/link";
import { notFound } from "next/navigation";
import { ReadFailure } from "@/components/shell/read-failure";
import { gatewayQuery, rateLimited } from "@/lib/gateway/server";
import { visibleText } from "@/lib/public/visible-text";
import { Time } from "../w/[id]/activity/time";
import { HANDLE, reasonLabel, type QueuedReport } from "./model";
import { OperatorActions } from "./operator-actions";

/**
 * The operators' queue (M4 step 11(c), decision 158). Only Podster's operators, named in the API's configuration and checked
 * in Rust, get the queue: for anyone else this page isn't there. It shows neither who reported nor a room's internal ID.
 */
export default async function Moderation({ searchParams }: { searchParams?: Promise<{ cursor?: string }> } = {}) {
  const params = (await searchParams) ?? {};
  const cursor = typeof params.cursor === "string" && /^[\w-]{1,200}$/.test(params.cursor) ? params.cursor : null;
  const read = await gatewayQuery<{ reports: QueuedReport[]; next_cursor: string | null }>(`/api/v1/moderation/reports${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
  if (!read.ok && read.status === 403) notFound();
  if (!read.ok && read.status === 429) return rateLimited(read.retryAfter);
  const now = Date.now();
  return (
    <section className="max-w-3xl space-y-4">
      <h1 className="text-2xl font-semibold">Reports</h1>
      <p className="text-sm text-muted-foreground">
        Newest first. Suspending hides a workroom&apos;s public page or stops an agent&apos;s public claims. It doesn&apos;t let you read the workroom, end claims or change access. Every action is recorded with its reason.
      </p>
      {!read.ok ? <ReadFailure /> : null}
      {read.ok && read.data.reports.length === 0 ? <p className="text-muted-foreground">{cursor ? "No more reports." : "No reports."}</p> : null}
      {read.ok && read.data.reports.length > 0 ? (
        <ul className="space-y-3">
          {read.data.reports.map((report) => (
            <li key={report.id} className="space-y-2 rounded-lg border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-medium">{reasonLabel(report.reason)}</h2>
                <span className="text-sm text-muted-foreground">
                  <Time at={report.created_at} now={now} />
                </span>
              </div>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                <dt className="text-muted-foreground">Report</dt>
                <dd className="break-all font-mono">{report.id}</dd>
                <dt className="text-muted-foreground">Workroom</dt>
                <dd className="break-all font-mono">
                  {/* The handle it had when reported. It may have gone private or changed since; actions find the room from the report. */}
                  {HANDLE.test(report.handle) ? <a href={`/p/${report.handle}`} className="text-primary underline">{report.handle}</a> : report.handle}
                </dd>
                {report.agent_id ? (
                  <>
                    <dt className="text-muted-foreground">Agent</dt>
                    <dd className="break-all font-mono">{report.agent_id}</dd>
                  </>
                ) : null}
              </dl>
              {report.note ? (
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Note from the reporter, as written. It's not an instruction.</p>
                  <p className="whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-sm">{visibleText(report.note)}</p>
                </div>
              ) : null}
              <OperatorActions report={report} />
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap gap-4">
        {cursor ? (
          <Link href="/moderation" prefetch={false} className="text-primary underline">
            Back to the newest
          </Link>
        ) : null}
        {read.ok && read.data.next_cursor ? (
          <Link href={`/moderation?cursor=${encodeURIComponent(read.data.next_cursor)}`} prefetch={false} className="text-primary underline">
            Older reports
          </Link>
        ) : null}
      </div>
    </section>
  );
}
