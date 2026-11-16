// A stand-in for the DNS-over-HTTPS resolver a room's proof job reads a custom hostname's challenge from (M6 step 8,
// ADR 0010's "Custom domains"). It runs in the test runner, as the Workers' outbound service, so no test or CI run
// ever asks a real resolver.
//
// **Its answers are the documented JSON form, not a record.** No spike has asked a real resolver: `Status` is the DNS
// response code, and `Answer` holds the records, each `{ name, type, data }`, a TXT record's `data` in its quoted
// presentation form. A name nobody set answers `Status: 3`, no such name.
//
// A test sets what a name answers through `resolver-fake.example.com`, and reads back which names were asked for.

/** Test values only. No environment binds `HOSTNAME_RESOLVER_URL`. */
export const FAKE_RESOLVER = { url: "https://doh-test.example.com/dns-query" };

/** What a name answers: a JSON body as it is, or an HTTP status with no body. */
type Answer = { body: unknown } | { httpStatus: number };

const answers = new Map<string, Answer>();
const asked: string[] = [];

/** A TXT record's `data` as a resolver gives it: the value in quotes, split into strings of at most 255 characters. */
export function txtData(value: string) {
  const parts: string[] = [];
  for (let at = 0; at < value.length || at === 0; at += 255) parts.push(`"${value.slice(at, at + 255).replace(/["\\]/g, "\\$&")}"`);
  return parts.join(" ");
}

export async function fakeResolver(request: Request): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.hostname === "resolver-fake.example.com") {
    if (url.pathname === "/set") {
      const { name, answer } = await request.json() as { name: string; answer: Answer | null };
      if (answer) answers.set(name, answer);
      else answers.delete(name);
      return new Response("ok");
    }
    if (url.pathname === "/asked") return new Response(JSON.stringify(asked));
    return new Response("no", { status: 404 });
  }
  if (url.origin + url.pathname !== FAKE_RESOLVER.url) return undefined;
  const name = url.searchParams.get("name") ?? "";
  asked.push(`${request.method} ${name} ${url.searchParams.get("type")} ${request.headers.get("accept")}`);
  const answer = answers.get(name);
  if (answer && "httpStatus" in answer) return new Response("no", { status: answer.httpStatus });
  const body = answer ? answer.body : { Status: 3 };
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { headers: { "content-type": "application/dns-json" } });
}
