# Runner's task image (M7 step 9(b)). Every task command runs in a container of it, through Runner's own tools: cat,
# tee, mkdir, rg, ls and kill (to end what a shell command leaves running) and, when the run policy names the shell,
# /bin/sh, under which a task's commands can also run node, npm and npx (Node.js 22.23.5 LTS, in /usr/local).
# Reproducible (item 12 of the deep review of #460): the base is pinned by digest (debian:bookworm-slim's index, read
# 2026-11-18), the packages come from one fixed snapshot.debian.org timestamp at exact versions, and Node is the
# official nodejs.org linux tarball for the build's architecture, checked against a SHA-256 written here (read
# 2026-11-20 from the release's SHASUMS256.txt, whose signature by a Node release key was checked first). The build
# never trusts a checksum file it fetches. Runner runs the built image only by its image ID, written to `task-image`
# in Runner's home:
#
#   docker build -q apps/runner/sandbox > ~/.podster-runner/task-image
#
# Building it fetches Debian's packages and Node, so it is the owner's to run. Nothing here holds a key or a secret.
# apt checks the snapshot's signed Release file; plain HTTP is what the slim image can reach before ca-certificates
# exists, and Docker's own ADD fetches Node over HTTPS.
#
# npm and npx run as Runner's non-root task user, with HOME at /work (the task's folder) and the rest of the file
# system read-only. The global npmrc below sends npm's cache and logs to /tmp (a tmpfs, noexec, which suits a cache)
# and its global prefix to /work/.npm-global, so nothing npm writes needs a writable /usr/local. The container has no
# network yet, so `npm install` and an npx of a package not already in the task's node_modules fail.
FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc AS fetch
ADD https://nodejs.org/dist/v22.23.5/node-v22.23.5-linux-arm64.tar.gz /fetch/linux-arm64.tar.gz
ADD https://nodejs.org/dist/v22.23.5/node-v22.23.5-linux-x64.tar.gz /fetch/linux-x64.tar.gz
RUN cd /fetch \
 && echo "8bd3dc69eee8f3f226315a80d7d1d4faccf217a4c8fae500168ac2e38f3bdba3  linux-arm64.tar.gz" > sums \
 && echo "c54118104acc524633b5abe106bbf44a53126ec8b4e5fa105cb92b5d7de8a1a1  linux-x64.tar.gz" >> sums \
 && sha256sum -c sums \
 && case "$(dpkg --print-architecture)" in arm64) arch=arm64 ;; amd64) arch=x64 ;; *) exit 1 ;; esac \
 && mkdir /node \
 && tar -xzf "linux-$arch.tar.gz" -C /node --strip-components=1 --no-same-owner \
 && rm -rf /node/include /node/share /node/CHANGELOG.md /node/README.md \
 && printf 'cache=/tmp/.npm\nprefix=/work/.npm-global\nupdate-notifier=false\nfund=false\naudit=false\n' > /node/etc-npmrc

FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
RUN rm -f /etc/apt/sources.list.d/debian.sources \
 && echo "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20261101T000000Z bookworm main" > /etc/apt/sources.list \
 && apt-get -o Acquire::Check-Valid-Until=false update \
 && apt-get install -y --no-install-recommends ripgrep=13.0.0-4+b2 procps=2:4.0.2-3 libproc2-0=2:4.0.2-3 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=fetch /node/bin /usr/local/bin
COPY --from=fetch /node/lib /usr/local/lib
COPY --from=fetch /node/etc-npmrc /usr/local/etc/npmrc
CMD ["sleep", "60"]
