"use client";

import { useRouter } from "next/navigation";
import { Tabs } from "radix-ui";
import { useRef, useState } from "react";
import { AgentContent, AuthorLine } from "@/components/agent-content/agent-content";
import { plainName } from "@/components/agent-content/text";
import { SheetLink, TargetSheet, type SheetApi } from "@/components/sheet/target-sheet";
import { Button } from "@/components/ui/button";
import { clientQuery } from "@/lib/gateway/client";
import { goToSignIn } from "../../../w/[id]/tasks/go-to-sign-in";
import { PrincipalName, TaskStatusBadge, Timestamp } from "../../../w/[id]/tasks/task-bits";
import { kindOf, nameOf, type Message, type Names, type Task, type TaskDetail } from "../../../w/[id]/tasks/task-model";
import { Activity, author, Details } from "../../../w/[id]/tasks/task-sheet";

/** What a thread read returns at most. A full page may have more after it. */
export const THREAD_PAGE = 50;

type Scope = { workspace: string; agent: string; me: string; names: Names; orgNames: Names };
type Overseen = TaskDetail & { thread: Message[] };

const tasksPath = ({ workspace, agent }: Pick<Scope, "workspace" | "agent">) => `/api/v1/workspaces/${encodeURIComponent(workspace)}/agents/${encodeURIComponent(agent)}/tasks`;

async function read<T>(path: string, signal: AbortSignal) {
  const result = await clientQuery<T>(path, { signal });
  if (result.ok) return result.data;
  if (result.status === 401) {
    goToSignIn();
    return new Promise<never>(() => undefined);
  }
  // An outage isn't "gone". Anything else is one message, whether it's missing or hidden.
  if (result.status >= 500 || result.status === 429) throw new Error(result.code);
  return null;
}

/** Anything but an outage says something about this viewer's access, and needs the same answer a Sheet's read gets. */
const isRefusal = (result: { status: number }) => result.status < 500 && result.status !== 429;

export function OverseenTasks({ workspace, agent, workspaceLabel, initial, initialCursor, me, names, orgNames }: Scope & { workspaceLabel: string; initial: Task[]; initialCursor: string | null }) {
  const scope = { workspace, agent, me, names, orgNames };
  const [more, setMore] = useState<Task[]>([]);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const router = useRouter();
  const tasks = [...initial, ...more.filter((task) => !initial.some((first) => first.id === task.id))];

  async function loadMore() {
    setLoading(true);
    setFailed(false);
    const result = await clientQuery<{ tasks: Task[]; next_cursor: string | null }>(`${tasksPath(scope)}?cursor=${encodeURIComponent(cursor ?? "")}`).catch(() => null);
    setLoading(false);
    if (result !== null && !result.ok && isRefusal(result)) {
      // The same as anywhere else here: a lapsed session signs in, and lost access is the page's one not-found.
      if (result.status === 401) goToSignIn();
      else router.refresh();
      return;
    }
    if (!result?.ok) return setFailed(true);
    setMore((previous) => [...previous, ...result.data.tasks]);
    setCursor(result.data.next_cursor);
  }

  return (
    <>
      <h2 className="text-lg font-semibold">Its tasks</h2>
      {tasks.length === 0 ? (
        <p className="text-muted-foreground">This agent isn't party to any tasks in this workroom.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {tasks.map((task) => (
            <li key={task.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
              <div className="min-w-0 space-y-1">
                {/* A title is whatever its author wrote, so it's plain text and wraps. */}
                <SheetLink param="task" target={task.id} className="break-words text-primary underline">
                  {plainName(task.title)}
                </SheetLink>
                {/* A task carries no organization until its history is read, so External shows in the Sheet. */}
                <AuthorLine author={{ name: nameOf(task.requester, me, names), kind: kindOf(task.requester) }} />
              </div>
              <TaskStatusBadge status={task.status} />
            </li>
          ))}
        </ul>
      )}
      {failed ? (
        <p role="alert" className="text-sm">
          Couldn't load more.
        </p>
      ) : null}
      {cursor !== null ? (
        <Button variant="outline" size="sm" disabled={loading} onClick={() => void loadMore()}>
          Load more
        </Button>
      ) : null}
      <TargetSheet<Overseen>
        param="task"
        size="lg"
        noun="task"
        load={async (target, { signal }) => {
          const path = `${tasksPath(scope)}/${encodeURIComponent(target)}`;
          const [detail, thread] = await Promise.all([read<TaskDetail>(path, signal), read<{ messages: Message[] }>(`${path}/messages`, signal)]);
          return detail && thread ? { ...detail, thread: thread.messages } : null;
        }}
        title={(data) => plainName(data.task.title)}
        description={() => `Workroom: ${workspaceLabel} · read-only oversight`}
        version={(data) => data.task.version}
      >
        {(api) => <OverseenTask api={api} scope={scope} />}
      </TargetSheet>
    </>
  );
}

function Party({ label, id, me, names }: { label: string; id: string | null; me: string; names: Names }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{id ? <PrincipalName id={id} label={nameOf(id, me, names)} me={me} /> : "Nobody yet"}</dd>
    </>
  );
}

/** No actions, and no way to add any: oversight only reads. */
function OverseenTask({ api, scope }: { api: SheetApi<Overseen>; scope: Scope }) {
  const { data } = api;
  const { me, names, orgNames } = scope;
  const { task } = data;
  return (
    <div className="space-y-4">
      <p className="rounded-lg border bg-muted/40 p-3 text-sm">Read-only. You're seeing what this agent sees, and you can't act on this task or post to it.</p>
      <TaskStatusBadge status={task.status} />
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        <Party label="Requester" id={task.requester} me={me} names={names} />
        <Party label="Assignee" id={task.assignee} me={me} names={names} />
        <Party label="Reviewer" id={task.reviewer} me={me} names={names} />
      </dl>
      <Tabs.Root defaultValue="details">
        <Tabs.List aria-label="Task sections" className="flex gap-1 overflow-x-auto border-b">
          {[
            ["details", "Details"],
            ["thread", "Thread"],
            ["activity", "Activity"],
          ].map(([value, label]) => (
            <Tabs.Trigger key={value} value={value} className="border-b-2 border-transparent px-3 py-2 whitespace-nowrap text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:outline-none data-[state=active]:border-primary data-[state=active]:font-medium data-[state=active]:text-foreground">
              {label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <Tabs.Content value="details" className="mt-4 space-y-4 outline-none">
          <Details data={data} me={me} names={names} orgNames={orgNames} overseen />
        </Tabs.Content>
        {/* Stays mounted, so messages already paged in are still there on coming back. */}
        <Tabs.Content value="thread" forceMount className="mt-4 outline-none data-[state=inactive]:hidden">
          <Thread key={task.id} api={api} scope={scope} />
        </Tabs.Content>
        <Tabs.Content value="activity" className="mt-4 outline-none">
          <Activity data={data} me={me} names={names} orgNames={orgNames} />
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}

function Thread({ api, scope }: { api: SheetApi<Overseen>; scope: Scope }) {
  const { data, run } = api;
  const { me, names, orgNames } = scope;
  const [more, setMore] = useState<Message[]>([]);
  const [exhausted, setExhausted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const busy = useRef(false);
  const seen = new Set(data.thread.map((message) => message.id));
  const messages = [...data.thread, ...more.filter((message) => !seen.has(message.id))];
  const hasMore = !exhausted && messages.length > 0 && (more.length > 0 || data.thread.length === THREAD_PAGE);

  async function loadMore() {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    setFailed(false);
    const result = await clientQuery<{ messages: Message[] }>(`${tasksPath(scope)}/${encodeURIComponent(data.task.id)}/messages?after=${encodeURIComponent(messages.at(-1)?.id ?? "")}`).catch(() => null);
    busy.current = false;
    setLoading(false);
    if (result !== null && !result.ok && isRefusal(result)) {
      if (result.status === 401) goToSignIn();
      // Reads the task again, which closes to the one not-found message if access has gone.
      else await run(async () => ({ ok: true, data: null }));
      return;
    }
    if (!result?.ok) return setFailed(true);
    setMore((previous) => [...previous, ...result.data.messages]);
    if (result.data.messages.length < THREAD_PAGE) setExhausted(true);
  }

  if (messages.length === 0) return <p className="text-sm text-muted-foreground">No messages yet.</p>;
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">Oldest first.</p>
      <ol className="space-y-3">
        {messages.map((message) => (
          <li key={message.id} className="space-y-1">
            <AgentContent author={author(message.from, me, names, orgNames)} external={message.external} body={message.body} />
            <p className="text-xs">
              <Timestamp at={message.created_at} />
            </p>
          </li>
        ))}
      </ol>
      {failed ? (
        <p role="alert" className="text-sm">
          Couldn't load more.
        </p>
      ) : null}
      {hasMore ? (
        <Button variant="outline" size="sm" disabled={loading} onClick={() => void loadMore()}>
          Load newer messages
        </Button>
      ) : null}
    </div>
  );
}
