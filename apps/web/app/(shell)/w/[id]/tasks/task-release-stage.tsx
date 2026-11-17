"use client";

import { useEffect, useState } from "react";
import { clientQuery } from "@/lib/gateway/client";
import { deploymentStage, parseTaskRelease, releaseHeadline, releaseSwitchedOn, type ReleaseRead } from "./release-stage";
import { Timestamp } from "./task-bits";
import { mergeLabel, type PullRequestChange } from "./task-change";

const TONES = { neutral: "", amber: "text-status-amber", blue: "", green: "", danger: "text-status-danger" } as const;

/**
 * The Release panel's deployment stage (M6 step 10(b)). It asks the room's release configuration first, only to tell
 * whether release is switched on for the deployment, which it isn't anywhere yet: off, nothing more is read and the
 * stage is Unavailable. On, and only for a merged task, it reads the task's release status. Never Live unless the room
 * says the commit is served (UI-02).
 */
export function DeploymentStageRow({ workspace, taskId, change }: { workspace: string; taskId: string; change: PullRequestChange }) {
  const [switchedOn, setSwitchedOn] = useState<boolean | null | undefined>(undefined);
  const [read, setRead] = useState<ReleaseRead | null>(null);
  const merged = change.merge_state === "succeeded";

  useEffect(() => {
    const controller = new AbortController();
    const base = `/api/v1/workspaces/${encodeURIComponent(workspace)}`;
    void (async () => {
      try {
        const on = releaseSwitchedOn(await clientQuery(`${base}/release-config`, { signal: controller.signal }));
        if (controller.signal.aborted) return;
        if (on === false || !merged) {
          setSwitchedOn(on);
          return;
        }
        const status = await clientQuery<unknown>(`${base}/tasks/${encodeURIComponent(taskId)}/release-status`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setRead(status.ok ? parseTaskRelease(status.data) : { kind: "failed" });
        setSwitchedOn(on);
      } catch {
        if (!controller.signal.aborted) setSwitchedOn(null);
      }
    })();
    return () => controller.abort();
  }, [workspace, taskId, merged]);

  if (switchedOn === undefined) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Checking deployment…
      </p>
    );
  }
  const stage = deploymentStage({ switchedOn, read, merge_state: change.merge_state, merge_sha: change.merge_sha });
  return (
    <div className="space-y-1 text-sm" data-testid="deployment-stage">
      {merged ? <p className="font-medium">{releaseHeadline(mergeLabel(change), stage)}</p> : null}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
        <dt className="text-muted-foreground">Deployment</dt>
        <dd className={TONES[stage.tone]}>
          {stage.label}
          {stage.commit ? (
            <span className="block text-xs text-muted-foreground">
              Commit{" "}
              <code className="font-mono" title={stage.commit}>
                {stage.commit.slice(0, 12)}
              </code>
              {stage.observedAt ? (
                <>
                  {" "}
                  · Recorded <Timestamp at={stage.observedAt} />
                </>
              ) : null}
            </span>
          ) : null}
        </dd>
      </dl>
      <p className="text-muted-foreground">{stage.text}</p>
      {stage.link ? (
        <a href={stage.link} target="_blank" rel="noopener noreferrer nofollow" className="break-all text-primary underline">
          Open the app <span className="text-muted-foreground">({new URL(stage.link).host})</span>
        </a>
      ) : null}
    </div>
  );
}
