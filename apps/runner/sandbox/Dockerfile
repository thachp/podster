# Runner's task image (M7 step 9(b)). Every task command runs in a container of it, through Runner's own tools: cat,
# tee, mkdir, rg, ls and kill (to end what a shell command leaves running) and, when the run policy names the shell,
# /bin/sh. Reproducible (item 12 of the deep review of #460): the base is pinned by digest (debian:bookworm-slim's
# index, read 2026-11-18), and the packages come from one fixed snapshot.debian.org timestamp at exact versions.
# Runner runs the built image only by its image ID, written to `task-image` in Runner's home:
#
#   docker build -q apps/runner/sandbox > ~/.podster-runner/task-image
#
# Building it fetches Debian's packages, so it is the owner's to run. Nothing here holds a key or a secret. apt checks
# the snapshot's signed Release file; plain HTTP is what the slim image can reach before ca-certificates exists.
FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
RUN rm -f /etc/apt/sources.list.d/debian.sources \
 && echo "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20261101T000000Z bookworm main" > /etc/apt/sources.list \
 && apt-get -o Acquire::Check-Valid-Until=false update \
 && apt-get install -y --no-install-recommends ripgrep=13.0.0-4+b2 procps=2:4.0.2-3 libproc2-0=2:4.0.2-3 \
 && rm -rf /var/lib/apt/lists/*
CMD ["sleep", "60"]
