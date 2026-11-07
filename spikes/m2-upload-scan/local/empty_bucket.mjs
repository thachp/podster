// Teardown's first step, while the Workers still exist: removes this spike's objects by prefix, and nothing else.
const { SPIKE_URL: base, SPIKE_TOKEN: token } = process.env;
if (!base || !token) throw new Error("set SPIKE_URL and SPIKE_TOKEN");
let deleted = 0;
for (let round = 0; round < 1000; round += 1) {
  const res = await fetch(new URL("/cleanup", base), { method: "POST", headers: { "x-spike-token": token } });
  if (!res.ok) throw new Error(`cleanup answered ${res.status}`);
  const body = await res.json();
  if (body.deleted === 0) {
    console.log(`removed ${deleted} objects; none left under spike/ or results/`);
    process.exit(0);
  }
  deleted += body.deleted;
}
throw new Error(`stopped after ${deleted} objects with more left`);
