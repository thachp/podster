"use client";

import { useRef, useState } from "react";
import { plainName } from "@/components/agent-content/text";
import type { SheetApi } from "@/components/sheet/target-sheet";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { clientCommand, clientQuery } from "@/lib/gateway/client";
import type { OutputsRead } from "../artifacts/artifacts-model";
import { FIELD_CLASS } from "./task-bits";
import { asConflict, type Task, type TaskDetail } from "./task-model";
import type { LoadedTask } from "./task-sheet";

/** What the header says about the output a task works toward. Its title is someone's text, shown plain. */
export function ExpectedOutputName({ output }: { output: TaskDetail["expected_output"] }) {
  if (!output) return <>None</>;
  return (
    <span className="break-words">
      {plainName(output.title)}
      {output.removed ? <span className="text-muted-foreground"> (removed)</span> : null}
    </span>
  );
}

const REFUSED: Record<string, string> = {
  output_not_found: "That output isn't there any more. Choose another.",
  not_allowed: "Only this task's requester, or an owner or admin of this workroom, can change its expected output.",
  invalid_argument: "Choose an output from the list.",
};

/** Why changing the output didn't go through. A stale read or a task that moved on is the Sheet's conflict, not this. */
export function outputLinkProblem(code: string, status: number) {
  if (code === "unknown" || status >= 500) return "We can't tell whether the expected output changed, so we read the task again. Check it above before trying again.";
  if (status === 401) return "That didn't save, and nothing changed. Your session has ended. Sign in again.";
  if (status === 429) return "That didn't save, and nothing changed. Too many requests, so wait a minute and try again.";
  if (code === "workspace_archived") return "That didn't save, and nothing changed. This workroom is archived, so nothing new can happen in it.";
  return `That didn't save, and nothing changed. ${REFUSED[code] ?? "You may no longer be allowed to do this."}`;
}

type Choices = { phase: "idle" } | { phase: "loading" } | { phase: "failed" } | { phase: "ready"; outputs: { id: string; title: string }[] };

/**
 * Which expected output a task works toward, for its requester or an admin, while it's open, offered or accepted (decision
 * 137). Tucked away until asked, because the list is a read of the room. The change answers to the task version on screen,
 * so an edit since is a conflict, and it moves the version, so an assignee acting on an older read rereads first.
 */
export function ChangeOutput({ api, onNotice, taskPath }: { api: SheetApi<LoadedTask>; onNotice: (notice: string | null) => void; taskPath: (data: LoadedTask, action: string) => string }) {
  const { data, run, saving } = api;
  const current = data.expected_output && !data.expected_output.removed ? data.expected_output.id : "";
  const [choices, setChoices] = useState<Choices>({ phase: "idle" });
  const [chosen, setChosen] = useState(current);
  const key = useIntentKey(`output:${data.task.version}:${chosen}`);
  const loading = useRef(false);

  const load = async () => {
    if (loading.current) return;
    loading.current = true;
    setChoices({ phase: "loading" });
    const read = await clientQuery<OutputsRead>(`/api/v1/workspaces/${encodeURIComponent(data.workspace)}/outputs`).catch(() => null);
    loading.current = false;
    setChoices(read?.ok ? { phase: "ready", outputs: read.data.outputs.map(({ id, title }) => ({ id, title })) } : { phase: "failed" });
  };

  const change = async () => {
    if (chosen === current) return;
    onNotice(null);
    const named = choices.phase === "ready" ? choices.outputs.find((output) => output.id === chosen)?.title : undefined;
    const result = await run(async (binding) => asConflict(await clientCommand<Task>(taskPath(data, "expected-output"), { version: binding.version, output_id: chosen === "" ? null : chosen }, { method: "PUT", idempotencyKey: key })), outputLinkProblem);
    if (result?.ok) onNotice(chosen === "" ? "This task no longer works toward an expected output." : `This task now works toward “${plainName(named ?? "the chosen output")}”.`);
  };

  return (
    <details
      className="rounded-lg border p-3"
      onToggle={(event) => {
        if (event.currentTarget.open && choices.phase !== "ready") void load();
      }}
    >
      <summary className="min-h-6 cursor-pointer text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">Change expected output</summary>
      <div className="mt-3 space-y-2">
        {choices.phase === "loading" || choices.phase === "idle" ? <p role="status" className="text-sm text-muted-foreground">Loading this workroom&apos;s outputs</p> : null}
        {choices.phase === "failed" ? (
          <p role="alert" className="text-sm text-status-danger">
            Couldn&apos;t load this workroom&apos;s outputs.{" "}
            <Button variant="link" className="h-auto p-0 text-status-danger underline" onClick={() => void load()}>
              Try again
            </Button>
          </p>
        ) : null}
        {choices.phase === "ready" ? (
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1 basis-56 space-y-1">
              <Label htmlFor="task-output">Expected output</Label>
              <select id="task-output" className={FIELD_CLASS} value={chosen} onChange={(event) => setChosen(event.target.value)} aria-describedby="task-output-hint">
                <option value="">None</option>
                {choices.outputs.map((output) => (
                  <option key={output.id} value={output.id}>
                    {plainName(output.title)}
                    {output.id === current ? " (current)" : ""}
                  </option>
                ))}
              </select>
            </div>
            <Button variant="outline" className="min-h-11 sm:min-h-9" disabled={saving || chosen === current} onClick={() => void change()}>
              {saving ? "Saving…" : "Set output"}
            </Button>
            <p id="task-output-hint" className="w-full text-xs text-muted-foreground">
              {choices.outputs.length === 0 ? "This workroom has no expected outputs yet. Its owner or an admin defines them on Artifacts. " : ""}
              Approving a submission with a link or a file makes the output Ready. This can&apos;t change once work is submitted.
            </p>
          </div>
        ) : null}
      </div>
    </details>
  );
}

/** One key per intent, so retrying after a lost response can't act twice. Changing what's being asked starts a new intent. */
function useIntentKey(intent: string) {
  const key = useRef({ intent, value: crypto.randomUUID() });
  if (key.current.intent !== intent) key.current = { intent, value: crypto.randomUUID() };
  return key.current.value;
}
