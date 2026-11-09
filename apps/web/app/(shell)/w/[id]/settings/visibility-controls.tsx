"use client";

import { useId, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { visibleName, visibleText } from "@/lib/public/visible-text";
import { useEarlyInput } from "@/hooks/use-early-input";
import { Button } from "@/components/ui/button";
import { CommandNotice, useCommands } from "../team/commands";
import { ConfirmAction } from "../team/confirm-action";
import { FIELD, MOBILE_TARGET } from "../team/field";
import { explainVisibilityRefusal, openingSummary, publishBlock, STALE_PREVIEW, suspensionReason, topicLabel, TOPICS, workflowLabel, type PublicPreview, type RoomVisibility } from "./visibility-model";

const day = (at: number) => new Date(at).toISOString().slice(0, 10);

/**
 * Exactly what the public page would hold, as the API built it. Text shows as typed here; the public page formats its
 * Markdown, shows each link's host and never loads an image.
 */
export function PreviewFields({ preview }: { preview: PublicPreview }) {
  const text = "min-w-0 whitespace-pre-wrap break-words";
  return (
    <dl className="grid gap-x-4 gap-y-2 rounded-lg border p-3 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
      <dt className="text-muted-foreground">Name</dt>
      <dd className="min-w-0 break-words">{visibleName(preview.name)}</dd>
      <dt className="text-muted-foreground">Goal</dt>
      <dd className={text}>{preview.goal === null ? <span className="text-muted-foreground">None</span> : visibleText(preview.goal)}</dd>
      <dt className="text-muted-foreground">Context</dt>
      <dd className={text}>{preview.context === null ? <span className="text-muted-foreground">None</span> : visibleText(preview.context)}</dd>
      <dt className="text-muted-foreground">Topic</dt>
      <dd>{topicLabel(preview.topic)}</dd>
      <dt className="text-muted-foreground">Workflow</dt>
      <dd>{workflowLabel(preview.workflow)}</dd>
      <dt className="text-muted-foreground">Openings</dt>
      <dd className="min-w-0">
        {preview.openings.length === 0 ? (
          <span className="text-muted-foreground">None</span>
        ) : (
          <ul className="space-y-2">
            {preview.openings.map((opening, index) => (
              <li key={`${opening.title}-${index}`} className="space-y-1">
                <p className="break-words font-medium">{visibleText(opening.title)}</p>
                <p className="text-muted-foreground">{openingSummary(opening)}</p>
                <p className={text}>{visibleText(opening.responsibilities)}</p>
                {opening.publicly_claimable ? <Badge variant="outline">Claimable from the public page</Badge> : null}
              </li>
            ))}
          </ul>
        )}
      </dd>
      <dt className="text-muted-foreground">Expected outputs</dt>
      <dd className="min-w-0">
        {preview.outputs.length === 0 ? (
          <span className="text-muted-foreground">None</span>
        ) : (
          <ul className="space-y-1">
            {preview.outputs.map((output, index) => (
              <li key={`${output.title}-${index}`} className="break-words">
                {visibleText(output.title)} · {output.ready ? "Ready" : "Not ready"}
                {output.description ? <span className={`block text-muted-foreground ${text}`}>{visibleText(output.description)}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </dd>
      <dt className="text-muted-foreground">Participants</dt>
      <dd>{preview.participant_count === 1 ? "1, as a number only" : `${preview.participant_count}, as a number only`}</dd>
      <dt className="text-muted-foreground">Review</dt>
      <dd>{preview.person_review ? "A person reviews the work" : "Agents may review the work"}</dd>
      {preview.archived ? (
        <>
          <dt className="text-muted-foreground">Status</dt>
          <dd>Archived</dd>
        </>
      ) : null}
    </dl>
  );
}

/**
 * Visibility in Settings (M4 step 11(a), ADR 0008): what's public, what would be, and going public or private. Going public
 * names the hash of exactly the preview shown, so a change since refuses it. Rust decides every request.
 */
export function VisibilityControls({ roomId, state, isOwner, archived }: { roomId: string; state: RoomVisibility; isOwner: boolean; archived: boolean }) {
  const early = useEarlyInput<HTMLDivElement>();
  // Neither command takes a policy version: publishing names the view instead.
  const commands = useCommands(null);
  const { send, clear, retrying } = commands;
  const ids = { topic: useId(), block: useId() };
  const [topic, setTopic] = useState<string | null>(null);
  const [endClaims, setEndClaims] = useState(false);
  const [pending, setPending] = useState(false);
  const after = useRef<HTMLDivElement>(null);
  const base = `/api/v1/workspaces/${encodeURIComponent(roomId)}`;
  const isPublic = state.visibility === "public";
  const shownTopic = topic ?? state.topic ?? "";
  const topicChanged = topic !== null && topic !== (state.topic ?? "");
  // An unsaved topic would change the view, so publishing now would name a view the owner isn't looking at.
  const block = publishBlock(state, { isOwner, archived }) ?? (topicChanged ? "Save the topic first." : null);
  const busy = pending || retrying;

  const saveTopic = async () => {
    if (busy || !topicChanged) return;
    setPending(true);
    await send(`${base}/topic`, { topic: topic === "" ? null : topic }, "Topic saved.", { method: "PUT", focus: true, explain: explainVisibilityRefusal, onOk: () => setTopic(null) });
    setPending(false);
  };

  const publish = () =>
    send<RoomVisibility>(`${base}/visibility`, { visibility: "public", view_hash: state.view_hash }, "This workroom is public now, under a new link.", {
      method: "PUT",
      explain: explainVisibilityRefusal,
      conflict: STALE_PREVIEW,
    });

  const unpublish = () =>
    send<RoomVisibility>(`${base}/visibility`, { visibility: "private", end_public_claims: endClaims }, endClaims ? "This workroom is private now, and its public claims have ended. Its old link won't work again." : "This workroom is private now. Its old link won't work again.", {
      method: "PUT",
      explain: explainVisibilityRefusal,
      onOk: () => setEndClaims(false),
    });

  return (
    <div ref={early} className="space-y-3">
      <div ref={after} tabIndex={-1} className="outline-none">
        <CommandNotice commands={commands} />
      </div>
      {state.suspension ? (
        <p role="note" className="rounded-lg bg-status-amber-surface p-3 text-sm text-status-amber">
          Suspended by Podster on {day(state.suspension.at)}, for {suspensionReason(state.suspension.reason)}. Its public page answers not found and it isn't listed in Explore. Nothing else in the workroom changed.
        </p>
      ) : null}
      {isPublic ? (
        <div className="space-y-1">
          {state.public_rooms_enabled ? (
            <p>
              Public{state.published_on ? ` since ${state.published_on}` : ""}. Anyone with the link can read the page, without signing in, and signed-in people and agents can find it in Explore.
            </p>
          ) : (
            <p>Public{state.published_on ? ` since ${state.published_on}` : ""}, but Podster isn&apos;t serving public pages right now. Its page answers not found until it does.</p>
          )}
          {state.public_handle ? (
            <p className="text-sm">
              <a href={`/p/${encodeURIComponent(state.public_handle)}`} className="text-primary underline">
                Open the public page
              </a>{" "}
              <span className="break-all font-mono text-muted-foreground">/p/{state.public_handle}</span>
            </p>
          ) : null}
          {state.public_claims_paused ? <p className="text-sm text-muted-foreground">Public claims are paused.</p> : null}
        </div>
      ) : (
        <p>Private. Only people and agents added or invited here can open it.</p>
      )}

      <div className="space-y-1">
        <label htmlFor={ids.topic} className="text-sm font-medium">
          Topic
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <select
            id={ids.topic}
            className={`${FIELD} w-auto`}
            value={shownTopic}
            disabled={busy}
            onChange={(event) => {
              clear();
              setTopic(event.target.value);
            }}
          >
            <option value="">None</option>
            {TOPICS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <Button type="button" size="sm" variant="outline" className={MOBILE_TARGET} disabled={busy || !topicChanged} onClick={() => void saveTopic()}>
            Save topic
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">Shown on the public page, and Explore can filter by it.</p>
      </div>

      <section aria-labelledby={`${ids.block}-preview`} className="space-y-2">
        <h3 id={`${ids.block}-preview`} className="font-medium">
          {isPublic ? "What's public now" : "What would be public"}
        </h3>
        <PreviewFields preview={state.preview} />
        <p className="text-sm text-muted-foreground">
          Never public: who's in the workroom, tasks, messages, files, activity and these settings. Openings marked claimable can be taken by an agent whose organization allows public claims, as a guest with that opening's preset.
        </p>
      </section>

      {isPublic ? (
        <div className="space-y-2">
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1 size-4" checked={endClaims} disabled={busy} onChange={(event) => setEndClaims(event.target.checked)} />
            <span>
              Also end public claims
              <span className="block text-muted-foreground">Agents that joined from the public page leave, as guests who withdraw do. Without this they stay.</span>
            </span>
          </label>
          <ConfirmAction
            label="Make private"
            destructive
            disabled={busy}
            title="Make this workroom private?"
            description={`Its public page answers not found at once and leaves Explore. The link won't work again: going public later makes a new one. Copies others already made, and search engines or archives, are outside Podster.${endClaims ? " Public claims end too." : ""}`}
            confirm="Make private"
            action={unpublish}
            focusAfter={after}
          />
        </div>
      ) : (
        <div className="space-y-2">
          {block ? (
            <p id={ids.block} className="text-sm text-muted-foreground">
              {block}
            </p>
          ) : null}
          <ConfirmAction
            label="Make public"
            describedBy={block ? ids.block : undefined}
            disabled={busy || block !== null}
            title="Make this workroom public?"
            description="Anyone can read exactly what's shown above, without signing in, and it's listed in Explore. Others may copy it, and Podster can't take those copies back. If anything above changes before you confirm, nothing goes public and you'll see the latest."
            confirm="Make public"
            action={publish}
            focusAfter={after}
          />
        </div>
      )}
    </div>
  );
}
