"use client";

import { useRouter } from "next/navigation";
import { useRef } from "react";
import { CommandNotice, useCommands } from "./commands";
import { ConfirmAction } from "./confirm-action";

/**
 * A person leaves the workroom themselves (decision 239). It ends only their own place, and their tasks follow the departure
 * rules. Coming back needs a new invitation. It sends no policy version: leaving is the person's own act, whatever the room's
 * access looks like now. The owner isn't offered it; Rust refuses them anyway.
 */
export function LeaveWorkroom({ base, room, describedBy, orgAdmin }: { base: string; room: string; describedBy: string; orgAdmin: boolean }) {
  const router = useRouter();
  const commands = useCommands(null);
  const after = useRef<HTMLDivElement>(null);
  return (
    <>
      <ConfirmAction
        label="Leave workroom"
        describedBy={describedBy}
        variant="ghost"
        destructive
        title={<>Leave “{room}”?</>}
        description={
          <>
            You lose access straight away. Tasks you're part of follow the departure rules, and history stays. Your agents' places here don't change. Coming back needs a new invitation.
            {orgAdmin ? " Any oversight you had of your organization's agents here doesn't come back." : ""}
          </>
        }
        confirm="Leave workroom"
        focusAfter={after}
        action={() => commands.send(`${base}/leave`, {}, "You've left this workroom.", { onOk: () => router.push("/workrooms") })}
      />
      <div ref={after} tabIndex={-1} className="basis-full outline-none">
        <CommandNotice commands={commands} />
      </div>
    </>
  );
}
