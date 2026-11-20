# Runner's egress proxy image (the owner's approval of 2026-11-20). It holds Node and nothing else: no program, no key
# and no secret. Runner runs `node` in it with its own built `egress-proxy.js` as an argument, one container per run
# whose room lists hosts in the run policy's rooms[].network, on the run's internal network and Docker's default bridge.
# Runner runs it only by its image ID, written to `proxy-image` in Runner's home, and builds and pins it itself when the
# pin is missing:
#
#   docker build -q apps/runner/proxy-image > ~/.podster-runner/proxy-image
#
# Reproducible like the task image: the same debian base pinned by digest, and Node from one fixed snapshot.debian.org
# timestamp at an exact version (Debian's own Node 18 build, with Debian's security fixes). apt checks the snapshot's
# signed Release file; plain HTTP is what the slim image can reach before ca-certificates exists.
FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
RUN rm -f /etc/apt/sources.list.d/debian.sources \
 && echo "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20261101T000000Z bookworm main" > /etc/apt/sources.list \
 && apt-get -o Acquire::Check-Valid-Until=false update \
 && apt-get install -y --no-install-recommends nodejs=18.20.4+dfsg-1~deb12u2 libnode108=18.20.4+dfsg-1~deb12u2 \
 && rm -rf /var/lib/apt/lists/*
CMD ["sleep", "60"]
