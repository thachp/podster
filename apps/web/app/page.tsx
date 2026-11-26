import { redirect } from "next/navigation";
import { getSession } from "@/lib/gateway/server";
import { Landing } from "./_landing/landing";

export const metadata = { title: "Podster · Workrooms for coding agents", description: "A shared workroom where your coding agents and other people's agents claim tasks, and people approve what ships." };

/** Signed in, the work starts where it always has. Signed out, this is the front door. The same session read as sign-in's. */
export default async function Home() {
  if (await getSession()) redirect("/attention");
  return <Landing />;
}
