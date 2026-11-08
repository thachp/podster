"use client";

import { useEffect, useState } from "react";

/**
 * How long to wait, counting down, and the way back. The count isn't a live region, so a screen reader isn't told every
 * second. It's told once, when it's time. The link works at any moment: trying early only comes back here.
 */
export function WaitThenRetry({ seconds, href }: { seconds: number | undefined; href: string }) {
  const [left, setLeft] = useState(seconds ?? 0);
  useEffect(() => {
    if (left <= 0) return;
    const timer = setTimeout(() => setLeft((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [left]);
  return (
    <>
      <p>{seconds === undefined ? "Try again in a minute." : left > 0 ? `Try again in ${left} ${left === 1 ? "second" : "seconds"}.` : "You can try again now."}</p>
      <p role="status" className="sr-only">
        {seconds !== undefined && left <= 0 ? "You can try again now." : ""}
      </p>
      {/* A full load, so the page is read again from the server. */}
      <a href={href} className="inline-flex min-h-11 items-center text-primary underline sm:min-h-6">
        Try again
      </a>
    </>
  );
}
