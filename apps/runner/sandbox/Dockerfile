# Runner's task image (M7 step 9(b)). Every task command runs in a container of it, through Runner's own tools: cat,
# tee, mkdir, rg and, when the run policy names the shell, /bin/sh. The base is pinned by digest (debian:bookworm-slim's
# index, read 2026-11-18). Runner runs the built image only by its image ID, written to `task-image` in Runner's home:
#
#   docker build -q apps/runner/sandbox > ~/.podster-runner/task-image
#
# Building it fetches Debian's packages, so it is the owner's to run. Nothing here holds a key or a secret.
FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
RUN apt-get update \
 && apt-get install -y --no-install-recommends ripgrep \
 && rm -rf /var/lib/apt/lists/*
CMD ["sleep", "infinity"]
