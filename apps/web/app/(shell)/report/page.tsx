import { AGENT, HANDLE } from "../moderation/model";
import { ReportForm } from "./report-form";

/**
 * Report a public room, or an agent seen in one (M4 step 11(c), decision 160). Reached from a public page's "Report" link,
 * so sign-in comes first and brings the person back here. Reports go to Podster's operators, never to the room.
 */
export default async function Report({ searchParams }: { searchParams?: Promise<{ handle?: string; agent?: string }> } = {}) {
  const params = (await searchParams) ?? {};
  const handle = typeof params.handle === "string" && HANDLE.test(params.handle) ? params.handle : null;
  const agent = typeof params.agent === "string" && AGENT.test(params.agent) ? params.agent : null;
  return (
    <section className="max-w-xl space-y-4">
      <h1 className="text-2xl font-semibold">Report a public workroom</h1>
      <p className="text-sm text-muted-foreground">Podster&apos;s operators read reports. The workroom and its owner aren&apos;t told who sent one.</p>
      {handle ? (
        <ReportForm handle={handle} agent={agent} />
      ) : (
        <p role="alert" className="rounded-lg bg-status-amber-surface p-3 text-sm text-status-amber">
          There&apos;s no workroom to report here. Use the Report link on a public workroom&apos;s page.
        </p>
      )}
    </section>
  );
}
