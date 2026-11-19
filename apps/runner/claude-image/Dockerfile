# Runner's Claude Code image (M7 step 9(b); the architect's ruling of 2026-11-18 after #460's real run). Claude Code
# runs in its own container per run, apart from the task's: the SDK's Linux binary at /opt/claude/claude, and socat,
# which the run's relay container uses to forward Claude Code's model requests to Runner's listener on the host. It
# holds no key and no secret. Runner runs it only by its image ID, written to `claude-image` in Runner's home:
#
#   docker build -q apps/runner/claude-image > ~/.podster-runner/claude-image
#
# Pinned: the same debian base by digest as the task image (already pulled, so no registry credentials are needed);
# socat at an exact version from one snapshot.debian.org timestamp; and Claude Code 2.1.327 as the SDK 0.3.327's Linux
# packages, fetched from npm's public registry with no credentials and checked against npm's sha512 integrity.
FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc AS fetch
ADD https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-linux-arm64/-/claude-agent-sdk-linux-arm64-0.3.327.tgz /fetch/linux-arm64.tgz
ADD https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-linux-x64/-/claude-agent-sdk-linux-x64-0.3.327.tgz /fetch/linux-x64.tgz
RUN cd /fetch \
 && echo "fe4e817d5f8bd9eafaed4a0b51a6dca74c372f50cc7a6263a228ddc6f5c3894f30f357c67c768a58a851ba151016622b30bc8cc9070129aa3250d48b5a8bcf9f  linux-arm64.tgz" > sums \
 && echo "a0074beca33d5150199404de4a387685a7848dec7537b65c1f358ed6d636860ca19322cd570fed5948484ceb9cc4cc28901c7efa1d9d3158f188f262679b9539  linux-x64.tgz" >> sums \
 && sha512sum -c sums \
 && case "$(dpkg --print-architecture)" in arm64) arch=arm64 ;; amd64) arch=x64 ;; *) exit 1 ;; esac \
 && tar -xzf "linux-$arch.tgz" -C /fetch \
 && install -D -m 0755 /fetch/package/claude /opt/claude/claude

FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
RUN rm -f /etc/apt/sources.list.d/debian.sources \
 && echo "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20261101T000000Z bookworm main" > /etc/apt/sources.list \
 && apt-get -o Acquire::Check-Valid-Until=false update \
 && apt-get install -y --no-install-recommends socat=1.7.4.4-2 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=fetch /opt/claude/claude /opt/claude/claude
CMD ["sleep", "60"]
