# Runner's egress proxy image (the owner's approval of 2026-11-20). It holds Node and nothing else: no program, no key
# and no secret. Runner runs `node` in it with its own built `egress-proxy.js` as an argument, one container per run
# whose room lists hosts in the run policy's rooms[].network, on the run's internal network and on an outbound network
# of the run's own that nothing else joins. Runner runs it only by its image ID, written to `proxy-image` in Runner's
# home, and builds and pins it itself when the pin is missing:
#
#   docker build -q apps/runner/proxy-image > ~/.podster-runner/proxy-image
#
# Reproducible like the task image: the same debian base pinned by digest, and the same official Node.js 22.23.5 LTS
# tarball as apps/runner/sandbox, for the build's architecture, checked against the SHA-256 written here (read
# 2026-11-20 from the release's SHASUMS256.txt, whose signature by a Node release key was checked first). The build never
# trusts a checksum file it fetches, and installs no Debian package. Only the `node` binary is kept: no npm, no npx.
# Keeping it patched means moving this pin, and the task image's, to a newer Node release.
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
 && install -D -m 0755 /node/bin/node /out/node

FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
COPY --from=fetch /out/node /usr/local/bin/node
CMD ["sleep", "60"]
