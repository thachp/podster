# Runner's Python toolchain image (the owner's ruling of 2026-11-20: no single large task image; a room chooses optional,
# pinned toolchains in its run policy, `"toolchains": ["python"]`). It is built FROM Runner's base task image, which
# Runner passes as BASE (a tag on its image ID; Runner then checks the result's layers start with that image's), so
# everything in apps/runner/sandbox (shell tools, Node 22) is here too:
#
#   docker build -q --pull=false --build-arg BASE=<task image> --build-arg ARCH=<aarch64|x86_64> apps/runner/toolchains/python
#
# Runner builds and pins it itself the first time a room needs it (`toolchain-image-python` in Runner's home), so this
# is never the owner's to run by hand. It holds no key or secret.
#
# What it adds: uv 0.13.9, from its official GitHub release tarball, and CPython 3.14.10, which that uv installs at
# build time from python-build-standalone's release 20261110 (the build uv 0.13.9 itself names for 3.14.10), fetched
# here and handed to uv as a local mirror, so uv downloads nothing. Runner passes ARCH, the Docker Engine's architecture
# as these releases name it (aarch64 or x86_64), so only that architecture's tarballs are fetched, with either of
# Docker's builders; the build stops unless it matches the image's own architecture. Each tarball's SHA-256 is written
# here and checked with `sha256sum -c`; the build never trusts a checksum file it fetches, and uv checks the Python
# tarball against its own built-in SHA-256 as well. The sums were read 2026-11-20 from the downloaded files after GitHub's build-provenance
# attestation for each was verified (`gh attestation verify --repo astral-sh/uv` and
# `--repo astral-sh/python-build-standalone`), and matched the digests GitHub's release API lists for each asset.
#
# Python lives read-only in /opt/uv/python, linked as python, python3 and python3.14 in /usr/local/bin. ca-certificates
# comes from the base image's snapshot.debian.org timestamp at an exact version, for Python's own ssl module; uv uses
# its own bundled roots. At run time Runner's fixed environment for a Python room points uv's cache at /work/.cache/uv,
# names this Python as the only one uv may use, and turns uv's Python downloads off. Projects make their virtual
# environments in /work, since the image is read-only.
ARG BASE
ARG ARCH

FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc AS fetch
ARG ARCH
ADD https://github.com/astral-sh/uv/releases/download/0.13.9/uv-${ARCH}-unknown-linux-gnu.tar.gz /fetch/uv.tar.gz
ADD https://github.com/astral-sh/python-build-standalone/releases/download/20261110/cpython-3.14.10%2B20261110-${ARCH}-unknown-linux-gnu-install_only_stripped.tar.gz /fetch/python.tar.gz
RUN cd /fetch \
 && case "$ARCH/$(dpkg --print-architecture)" in \
      aarch64/arm64) printf '%s  %s\n' \
        0797542018e541a9288855df555c8077eed06f7a47d206362030480e8ecc9f3d uv.tar.gz \
        38fd50f07170adc29d481913d1c30b17ecb538fbe290315fe1f83d84fdd5b694 python.tar.gz > sums ;; \
      x86_64/amd64) printf '%s  %s\n' \
        a7fbaff2b9a271d85c1bdb540941090fd1ce011797b4abeb48e4dcd39c2471d5 uv.tar.gz \
        c2ff2e97422f5d3896a16e0317fd212ba977bbf2688d93a6f7a03d817506bd30 python.tar.gz > sums ;; \
      *) exit 1 ;; \
    esac \
 && sha256sum -c sums \
 && mkdir -p /mirror/20261110 uv \
 && mv python.tar.gz "/mirror/20261110/cpython-3.14.10+20261110-$ARCH-unknown-linux-gnu-install_only_stripped.tar.gz" \
 && tar -xzf uv.tar.gz -C uv --strip-components=1 --no-same-owner \
 && install -D -m 0755 uv/uv /opt/uv/bin/uv \
 && install -D -m 0755 uv/uvx /opt/uv/bin/uvx \
 && UV_PYTHON_INSTALL_DIR=/opt/uv/python UV_PYTHON_INSTALL_MIRROR=file:///mirror UV_NO_CACHE=1 \
    /opt/uv/bin/uv python install --no-bin --no-registry 3.14.10 \
 && test -x /opt/uv/python/cpython-3.14.10-linux-*-gnu/bin/python3.14 \
 && ln -s /opt/uv/python/cpython-3.14.10-linux-*-gnu /opt/uv/python/current

FROM ${BASE}
RUN apt-get -o Acquire::Check-Valid-Until=false update \
 && apt-get install -y --no-install-recommends ca-certificates=20230311+deb12u1 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=fetch /opt/uv /opt/uv
RUN ln -s /opt/uv/bin/uv /opt/uv/bin/uvx /usr/local/bin/ \
 && ln -s /opt/uv/python/current/bin/python3.14 /usr/local/bin/python3.14 \
 && ln -s /opt/uv/python/current/bin/python3.14 /usr/local/bin/python3 \
 && ln -s /opt/uv/python/current/bin/python3.14 /usr/local/bin/python
CMD ["sleep", "60"]
