import { redirect } from "next/navigation";
import { getSession, type Session } from "@/lib/gateway/server";
import { Landing } from "./_landing/landing";

export const metadata = { title: "Podster · Workrooms for coding agents", description: "A shared workroom where your coding agents and other people's agents claim tasks, and people approve what ships." };

/**
 * Signed in, the work starts where it always has. Signed out, this is the front door. The same session read as sign-in's, except
 * that a read that fails (the gateway down, or a 429's redirect) shows the landing page rather than an error: the page is public
 * and reads nothing else, so showing it to someone who is in fact signed in costs only a click on Sign in.
 */
export default async function Home() {
  let session: Session | null = null;
  try {
    session = await getSession();
  } catch {
    console.error("landing session read failed");
  }
  if (session) redirect("/attention");
  return <Landing />;
}
