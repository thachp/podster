import { describe, expect, it } from "vitest";
import { ReleaseSection } from "@/app/(shell)/w/[id]/settings/release-section";
import { boundaryProblems, clientComponents, isClientSource } from "./client-boundary";

const Client = (_props: Record<string, unknown>) => null;
const Server = ({ children }: { children?: React.ReactNode }) => <section>{children}</section>;
const clients = new Map<unknown, string>([[Client, "Client (test)"]]);
class Thing {}

describe("the client boundary guard", () => {
  it("reads which modules are client components from their first statement", () => {
    expect(isClientSource('"use client";\nimport x from "y";')).toBe(true);
    expect(isClientSource("// a note\n'use client';")).toBe(true);
    expect(isClientSource('import x from "y";\n"use client";')).toBe(false);
  });

  it("finds this app's client components, and not its server pages", async () => {
    const found = await clientComponents();
    expect(found.has(ReleaseSection)).toBe(true);
    expect([...found.values()].some((name) => name.includes("settings/page.tsx"))).toBe(false);
  });

  it("names a function, a class instance or an unregistered symbol passed to a client component, wherever it sits", () => {
    const tree = (
      <Server>
        <div>
          <Client name="ok" at={new Date(0)} list={[1, "a", null]} nested={{ fine: true }} slot={<Client inner={() => 1} />} onPick={() => 1} />
          <Client thing={new Thing()} tag={Symbol("x")} shared={Symbol.for("x")} />
        </div>
      </Server>
    );
    expect(boundaryProblems(tree, clients)).toEqual(["<Client> prop inner is a function", "<Client> prop onPick is a function", "<Client> prop thing is an instance of Thing", "<Client> prop tag is a symbol that isn't registered"]);
  });

  it("leaves server components' own props alone, and finds a client component a server component renders", () => {
    const Wraps = ({ pick }: { pick: () => number }) => <Client n={pick()} again={pick} />;
    expect(boundaryProblems(<Wraps pick={() => 2} />, clients)).toEqual(["<Client> prop again is a function"]);
    expect(boundaryProblems(<Server>{[<Client key="a" n={1} />]}</Server>, clients)).toEqual([]);
  });
});
