"use client";

import { Check, Copy } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Tabs } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import { AuthorLine } from "@/components/agent-content/agent-content";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { clientQuery } from "@/lib/gateway/client";
import type { DirectoryAgent } from "../model";

/** An approval happens in another tab, and this is how the Sheet finds out. It only runs while the Sheet is in view. */
export const WATCH_EVERY_MS = 10_000;

function CopyField({ label, value }: { label: string; value: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
  }
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium">{label}</p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 rounded-md bg-muted p-2 text-sm break-all">{value}</code>
        <Button variant="outline" size="sm" className="min-h-11 shrink-0 sm:min-h-8" aria-label={`Copy ${label}`} onClick={() => void copy()}>
          {state === "copied" ? <Check aria-hidden /> : <Copy aria-hidden />} Copy
        </Button>
      </div>
      <p role="status" className="text-xs text-muted-foreground">
        {state === "copied" ? "Copied." : state === "failed" ? "Couldn't copy. Select the address and copy it yourself." : ""}
      </p>
    </div>
  );
}

const TRIGGER = "min-h-11 flex-1 rounded-md px-2 py-1 text-sm font-medium text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:outline-none data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm";

/** Watches the directory for an agent that wasn't there when the Sheet opened. A failed look just waits for the next. */
function useNewAgent(enabled: boolean) {
  const [found, setFound] = useState<DirectoryAgent | null>(null);
  const router = useRouter();
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let known: Set<string> | null = null;
    let stop = false;
    async function look() {
      if (stop || document.visibilityState === "hidden") return;
      const result = await clientQuery<{ agents: DirectoryAgent[] }>("/api/agents", { signal: controller.signal }).catch(() => null);
      if (stop || !result?.ok) return;
      if (known === null) {
        known = new Set(result.data.agents.map((agent) => agent.id));
        return;
      }
      const seen = known;
      const arrived = result.data.agents.find((agent) => !seen.has(agent.id));
      if (arrived) {
        stop = true;
        clearInterval(timer);
        setFound(arrived);
        router.refresh();
      }
    }
    void look();
    const timer = setInterval(() => void look(), WATCH_EVERY_MS);
    return () => {
      stop = true;
      clearInterval(timer);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
  return found;
}

export function ConnectSheet({ gatewayUrl, canConnect }: { gatewayUrl: string; canConnect: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(true);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const connected = useNewAgent(canConnect);

  function close() {
    setOpen(false);
    router.push("/agents", { scroll: false });
  }

  return (
    <Sheet open={open} onOpenChange={(next) => !next && close()}>
      <SheetContent
        side="right"
        className="w-full overflow-y-auto sm:max-w-[480px]"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          titleRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          (document.querySelector<HTMLElement>("[data-connect-launcher]") ?? document.getElementById("main-content"))?.focus();
        }}
      >
        <SheetHeader>
          <SheetTitle ref={titleRef} tabIndex={-1} className="pr-8 outline-none">
            Add an agent
          </SheetTitle>
          <SheetDescription>Gives an agent an identity in your organization. Choose how it runs.</SheetDescription>
        </SheetHeader>
        <div className="flex-1 space-y-4 px-4 pb-4">
          {!canConnect ? (
            <p>Only an organization's admins can add an agent. Ask one of yours to add it.</p>
          ) : (
            <>
              <section aria-labelledby="add-runner" className="space-y-3 rounded-lg border p-3">
                <div>
                  <h3 id="add-runner" className="font-medium">
                    Run it on my machine (Podster Runner)
                  </h3>
                  <p className="text-xs text-muted-foreground">Recommended</p>
                </div>
                <p className="text-sm">
                  Runner runs the agent&apos;s tasks on your machine, in Docker, with your own provider key. You approve each run, or set
                  your own run policy in Runner.
                </p>
                <p className="text-sm">
                  Pairing creates the agent and gives you one command to run, <code className="font-mono text-xs">npx --ignore-scripts podster@test pair</code>,
                  with the agent&apos;s ID. Then you confirm the machine here.
                </p>
                <Button asChild className="min-h-11 sm:min-h-9">
                  <Link href="/pairing/new" prefetch={false}>
                    Pair with Runner
                  </Link>
                </Button>
              </section>
              <section aria-labelledby="add-connect" className="space-y-3">
                <div>
                  <h3 id="add-connect" className="font-medium">
                    Connect an agent you already run
                  </h3>
                  <p className="text-sm text-muted-foreground">For an agent you run yourself, through an MCP client or the agent&apos;s own Agent Auth.</p>
                </div>
                <div aria-live="polite">
                  {connected ? (
                    <div className="space-y-2 rounded-lg bg-status-green-surface p-3 text-sm text-status-green">
                      <p className="font-medium">Connected</p>
                      {/* The name is the agent's own choice, so it stays attributed and off the success line. */}
                      <div className="rounded-md bg-background p-2">
                        <AuthorLine author={{ name: connected.name, kind: "agent" }} />
                      </div>
                      <p>It has no workroom access yet. Next, a workroom's owner or admin invites your organization, and you accept for this agent.</p>
                      <p>
                        <Link href="/workrooms" prefetch={false} className="underline">
                          Go to workrooms
                        </Link>
                      </p>
                    </div>
                  ) : null}
                </div>
                <Tabs.Root defaultValue="mcp" className="space-y-3">
                  <Tabs.List aria-label="How to connect" className="flex gap-1 rounded-lg bg-muted p-1">
                    <Tabs.Trigger value="mcp" className={TRIGGER}>
                      MCP client
                    </Tabs.Trigger>
                    <Tabs.Trigger value="agent-auth" className={TRIGGER}>
                      Connect your own agent
                      <span className="block text-xs font-normal">Agent Auth</span>
                    </Tabs.Trigger>
                  </Tabs.List>
                  <Tabs.Content value="mcp" className="space-y-3 outline-none">
                    <CopyField label="MCP server address" value={`${gatewayUrl}/mcp`} />
                    <ol className="list-decimal space-y-2 pl-5 text-sm">
                      <li>Add this address to your MCP client as a remote server.</li>
                      <li>Your client opens a Podster page. Sign in, choose the organization and name the agent.</li>
                      <li>Approve it. One approved connection is one agent, and it appears on the Agents page.</li>
                    </ol>
                  </Tabs.Content>
                  <Tabs.Content value="agent-auth" className="space-y-3 outline-none">
                    <CopyField label="Agent Auth discovery address" value={`${gatewayUrl}/.well-known/agent-configuration`} />
                    <ol className="list-decimal space-y-2 pl-5 text-sm">
                      <li>Give this address to your agent. It registers itself and gets a pending identity that can't do anything yet.</li>
                      <li>Your agent returns a claim link and a code.</li>
                      <li>Open the link to confirm you own the agent. Check the code matches, then choose its organization.</li>
                    </ol>
                    <p className="text-sm text-muted-foreground">An agent can't vouch for itself, so only a person's claim makes it yours.</p>
                  </Tabs.Content>
                </Tabs.Root>
                <p className="text-sm text-muted-foreground">Connecting doesn&apos;t create, run or wake an agent.</p>
              </section>
            </>
          )}
        </div>
        <SheetFooter>
          <p className="text-sm text-muted-foreground">Adding an agent gives it no workroom access. That&apos;s set separately.</p>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
