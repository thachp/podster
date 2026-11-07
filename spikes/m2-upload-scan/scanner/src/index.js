import { Container, ContainerProxy, getContainer } from "@cloudflare/containers";

export { ContainerProxy };

/** It holds no secrets and reaches nothing but the signature mirror. It's handed one file at a time and answers with a verdict. */
export class ClamAV extends Container {
  defaultPort = 8080;
  sleepAfter = "5m";
  enableInternet = false;
  interceptHttps = true;
  allowedHosts = ["database.clamav.net"];
  // Listening starts at once. /scan waits for the signatures to load, which is the cold start being measured.
  pingEndpoint = "localhost/live";
}

const report = (env, id, result) => env.API.fetch(`https://spike/results/${id}`, { method: "POST", body: JSON.stringify(result) });

/** For what only a deployment can show: the Container's health, whether its allowlist holds, and what a signature update costs. */
async function probe(job, env) {
  const clamav = getContainer(env.CLAMAV, "scanner");
  const read = async (path, method = "GET") => (await clamav.fetch(new Request(`http://scanner${path}`, { method }))).json();
  const result = { verdict: "probe", health: await read("/health"), egress: await read("/egress-check") };
  if (job.kind === "probe-update") result.update = await read("/update-signatures", "POST");
  const reported = await report(env, job.id, result);
  if (!reported.ok) throw new Error(`recording answered ${reported.status}`);
}

async function scan(job, env) {
  if (env.FORCE_FAILURE_PREFIX && job.id.startsWith(env.FORCE_FAILURE_PREFIX)) throw new Error("forced by the local run");
  const object = await env.ASSETS.get(job.key);
  if (!object) return report(env, job.id, { verdict: "failed", reason: "object_missing" });
  const started = Date.now();
  const response = await getContainer(env.CLAMAV, "scanner").fetch(
    new Request("http://scanner/scan", { method: "POST", headers: { "content-length": String(object.size) }, body: object.body }),
  );
  // Only a verdict from the scanner counts. Anything else is the scanner being unavailable, so the queue tries again.
  if (response.status !== 200) throw new Error(`scanner answered ${response.status}`);
  const verdict = await response.json();
  const reported = await report(env, job.id, { ...verdict, bytes: object.size, wall_ms: Date.now() - started });
  if (!reported.ok) throw new Error(`recording answered ${reported.status}`);
  console.log(JSON.stringify({ at: "scanner", id: job.id, verdict: verdict.verdict, wall_ms: Date.now() - started }));
}

export default {
  async queue(batch, env) {
    for (const message of batch.messages) {
      const job = message.body;
      // Tried and retried without a verdict. It stays undownloadable, and the record says it failed.
      if (batch.queue.includes("dlq")) {
        await report(env, job.id, { verdict: "failed", reason: "no_verdict_after_retries" });
        message.ack();
        continue;
      }
      try {
        await (job.kind ? probe(job, env) : scan(job, env));
        message.ack();
      } catch (problem) {
        console.log(JSON.stringify({ at: "scanner", id: job.id, retry: true, attempts: message.attempts, error: String(problem.message).slice(0, 80) }));
        message.retry();
      }
    }
  },
};
