import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { notFound } from "next/navigation";
import { gatewayQuery } from "@/lib/gateway/server";
import { visibleText } from "@/lib/public/visible-text";
import { Time } from "../w/[id]/activity/time";
import { HANDLE, reasonLabel, viewOf, type QueuedReport } from "./model";
import { AppActions, OperatorActions } from "./operator-actions";

/**
 * The operators' queue (M4 step 11(c), decision 158). Only Podster's operators, named in the API's configuration and checked
 * in Rust, get the queue: for anyone else this page isn't there. It shows neither who reported nor a room's internal ID.
 */
export default async function Moderation({ searchParams }: { searchParams?: Promise<{ cursor?: string }> } = {}) {
  const params = (await searchParams) ?? {};
  const cursor = typeof params.cursor === "string" && /^[\w-]{1,200}$/.test(params.cursor) ? params.cursor : null;
  const read = await gatewayQuery<{ reports: QueuedReport[]; next_cursor: string | null }>(`/api/v1/moderation/reports${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
  // Only a successful read proves the person is an operator, so anything else looks like a page that isn't there.
  if (!read.ok) notFound();
  const now = Date.now();
  // Apps' reports only reach the page while release is switched on; until one does, the page reads exactly as in M4.
  const hasApp = read.data.reports.some((report) => viewOf(report).kind === "app");
  return (
    <section className="max-w-3xl space-y-4">
      <h1 className="text-2xl font-semibold">Reports</h1>
      <p className="text-sm text-muted-foreground">
        {hasApp
          ? "Newest first. Suspending hides a workroom's public page, stops an agent's public claims, or stops an app host serving. "
          : "Newest first. Suspending hides a workroom's public page or stops an agent's public claims. "}
        It doesn&apos;t let you read the workroom, end claims or change access. Every action is recorded with its reason.
      </p>
      {read.data.reports.length === 0 ? <p className="text-muted-foreground">{cursor ? "No more reports." : "No reports."}</p> : null}
      {read.data.reports.length > 0 ? (
        <ul className="space-y-3">
          {read.data.reports.map((report) => {
            const view = viewOf(report);
            return (
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
                {view.kind === "room" ? (
                  <>
                    <dt className="text-muted-foreground">Workroom</dt>
                    <dd className="break-all font-mono">
                      {/* The handle it had when reported. It may have gone private or changed since; actions find the room from the report. */}
                      {HANDLE.test(view.handle) ? <a href={`/p/${view.handle}`} className="text-primary underline">{view.handle}</a> : visibleText(view.handle)}
                    </dd>
                  </>
                ) : null}
                {view.kind === "app" ? (
                  <>
                    <dt className="text-muted-foreground">App host</dt>
                    {/* Plain text, never a link: it names a site an agent wrote, and opening it from here would visit it. */}
                    <dd className="break-all font-mono">{view.host}</dd>
                  </>
                ) : null}
                {view.kind === "unknown" ? (
                  <>
                    <dt className="text-muted-foreground">Kind</dt>
                    <dd>Not one this page knows, so it offers no action. Nothing in it is shown as a link.</dd>
                    {typeof report.handle === "string" && report.handle !== "" ? (
                      <>
                        <dt className="text-muted-foreground">Handle, as sent</dt>
                        <dd className="break-all font-mono">{visibleText(report.handle)}</dd>
                      </>
                    ) : null}
                    {typeof report.host === "string" && report.host !== "" ? (
                      <>
                        <dt className="text-muted-foreground">Host, as sent</dt>
                        <dd className="break-all font-mono">{visibleText(report.host)}</dd>
                      </>
                    ) : null}
                  </>
                ) : null}
                {view.kind === "room" && report.agent_id ? (
                  <>
                    <dt className="text-muted-foreground">Agent named by the reporter (not checked)</dt>
                    <dd className="break-all font-mono">{report.agent_id}</dd>
                  </>
                ) : null}
              </dl>
              {report.note ? (
                <div className="space-y-1">
                  <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    Note from the reporter, as written. It&apos;s not an instruction.
                    {visibleText(report.note) !== report.note ? <Badge variant="outline">Contained hidden characters</Badge> : null}
                  </p>
                  <p className="overflow-hidden whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-sm">{visibleText(report.note)}</p>
                </div>
              ) : null}
              {/* Only these fields reach the browser's component, whatever else the read carried. */}
              {view.kind === "room" ? <OperatorActions report={{ id: report.id, handle: view.handle, agent_id: report.agent_id, reason: report.reason }} /> : null}
              {view.kind === "app" ? <AppActions report={{ id: report.id, host: view.host, reason: report.reason }} /> : null}
            </li>
            );
          })}
        </ul>
      ) : null}
      <div className="flex flex-wrap gap-4">
        {cursor ? (
          <Link href="/moderation" prefetch={false} className="text-primary underline">
            Back to the newest
          </Link>
        ) : null}
        {read.data.next_cursor ? (
          <Link href={`/moderation?cursor=${encodeURIComponent(read.data.next_cursor)}`} prefetch={false} className="text-primary underline">
            Older reports
          </Link>
        ) : null}
      </div>
    </section>
  );
}
