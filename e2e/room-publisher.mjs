// The staging run's public rooms: making them public, and making every one private again when the run ends or is stopped.
// Its own module so the ordering can be tested with a stubbed `dash` (room-publisher-selftest.mjs).
//
// The race it closes: a stop can arrive at any point of a publish. So a publish is tracked from before its first request,
// stopping is checked again right before the PUT, and the room is listed as possibly public before the PUT is sent, since a
// PUT that throws may still have landed. Clean-up waits for publishes in flight, bounded, and sweeps twice, so a PUT that
// lands during the first sweep is undone by the second.

export class RoomPublisher {
  /** Rooms possibly public, each with its owner, whom clean-up asks. */
  published = new Map();
  stopping = false;
  #inFlight = new Set();

  /** `putTimeoutMs` bounds the publish PUT, and must be shorter than `stopWaitMs`, clean-up's wait for publishes in flight. */
  constructor({ putTimeoutMs = 30_000, stopWaitMs = 60_000, sleep = (ms) => new Promise((done) => setTimeout(done, ms)) } = {}) {
    if (putTimeoutMs >= stopWaitMs) throw new Error("the publish PUT's timeout must be shorter than clean-up's wait");
    Object.assign(this, { putTimeoutMs, stopWaitMs, sleep });
  }

  /** Makes a room public, unless the run is stopping. Answers the PUT's result. */
  publish(owner, id) {
    if (this.stopping) return Promise.reject(new Error("the run is stopping, so nothing more is published"));
    const work = (async () => {
      const read = await owner.dash("GET", `/v1/workspaces/${id}/visibility`);
      if (!read.ok) return read;
      if (this.stopping) throw new Error("the run is stopping, so nothing more is published");
      // From here it may be public, even if the PUT throws, so clean-up asks it to be private either way.
      this.published.set(id, owner);
      const done = await owner.dash("PUT", `/v1/workspaces/${id}/visibility`, { visibility: "public", view_hash: read.body.view_hash }, { timeoutMs: this.putTimeoutMs });
      // A refusal means it didn't go public. Anything else, a server error included, may have.
      if (!done.ok && done.status < 500) this.published.delete(id);
      return done;
    })();
    this.#inFlight.add(work);
    return work.finally(() => this.#inFlight.delete(work));
  }

  /** Makes a room private again, and stops listing it. */
  async unpublish(owner, id, extra = {}) {
    const done = await owner.dash("PUT", `/v1/workspaces/${id}/visibility`, { visibility: "private", ...extra });
    if (done.ok) this.published.delete(id);
    return done;
  }

  /** Stops publishing, waits for publishes in flight, bounded, then sweeps twice. Answers how many were made private, and how many weren't. */
  async stop() {
    this.stopping = true;
    await Promise.race([Promise.allSettled([...this.#inFlight]), this.sleep(this.stopWaitMs)]);
    const madePrivate = new Set();
    for (let pass = 0; pass < 2; pass++) {
      for (const [id, owner] of [...this.published]) {
        const done = await owner.dash("PUT", `/v1/workspaces/${id}/visibility`, { visibility: "private" }).catch(() => null);
        if (done?.ok) {
          madePrivate.add(id);
          // A PUT still landing could make it public again, so it stays listed for the second pass.
          if (pass === 1) this.published.delete(id);
        }
      }
    }
    return { madePrivate: madePrivate.size, left: this.published.size };
  }
}
