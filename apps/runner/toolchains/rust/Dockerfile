# Runner's Rust toolchain image (the owner's ruling of 2026-11-20: no single large task image; a room chooses optional,
# pinned toolchains in its run policy, `"toolchains": ["rust"]`). It is built FROM Runner's base task image, which Runner
# passes as BASE (a tag on its image ID; Runner then checks the result's layers start with that image's), so everything
# in apps/runner/sandbox (shell tools, Node 22) is here too:
#
#   docker build -q --pull=false --build-arg BASE=<task image> --build-arg ARCH=<aarch64|x86_64> apps/runner/toolchains/rust
#
# Runner builds and pins it itself the first time a room needs it (`toolchain-image-rust` in Runner's home), so this is
# never the owner's to run by hand. It holds no key or secret.
#
# What it adds: Rust 1.100.0 stable (rustc, cargo, rust-std for the build's own architecture, rustfmt and clippy) from
# the official standalone component tarballs on static.rust-lang.org, installed to /opt/rust with each tarball's own
# install.sh, and linked into /usr/local/bin. There is no rustup, at build or run time. The SHA-256 of each tarball is
# written here and checked with `sha256sum -c`; the build never trusts a checksum file it fetches. The sums were read
# 2026-11-20 from channel-rust-stable.toml (dated 2026-11-12, rust 1.100.0 0ef1bc386), after that manifest's detached
# signature, channel-rust-stable.toml.asc, was checked against the Rust release key
# 108F 6620 5EAE B0AA A8DD 5E1C 85AB 96E6 FA1B E5FE.
#
# rustc needs a C linker and C runtime to link a program, and many build scripts compile C, so gcc 12, binutils and
# libc6-dev come from the same snapshot.debian.org timestamp as the base image, at exact versions, with
# ca-certificates so cargo can verify crates.io over TLS when a room's network lists it. Runner passes ARCH, the Docker
# Engine's architecture as Rust names it (aarch64 or x86_64), so only that architecture's tarballs are fetched, with
# either of Docker's builders; the build stops unless it matches the image's own architecture.
#
# At run time Runner's fixed environment for a Rust room sets CARGO_HOME=/work/.cargo, so cargo's registry cache and
# `cargo install` land in the task's folder. Builds go to cargo's default target folder inside the crate, under /work,
# which can run build scripts; /tmp is noexec and can't.
ARG BASE
ARG ARCH

FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc AS fetch
ARG ARCH
ADD https://static.rust-lang.org/dist/2026-11-12/rustc-1.100.0-${ARCH}-unknown-linux-gnu.tar.gz /fetch/rustc.tar.gz
ADD https://static.rust-lang.org/dist/2026-11-12/cargo-1.100.0-${ARCH}-unknown-linux-gnu.tar.gz /fetch/cargo.tar.gz
ADD https://static.rust-lang.org/dist/2026-11-12/rust-std-1.100.0-${ARCH}-unknown-linux-gnu.tar.gz /fetch/rust-std.tar.gz
ADD https://static.rust-lang.org/dist/2026-11-12/rustfmt-1.100.0-${ARCH}-unknown-linux-gnu.tar.gz /fetch/rustfmt.tar.gz
ADD https://static.rust-lang.org/dist/2026-11-12/clippy-1.100.0-${ARCH}-unknown-linux-gnu.tar.gz /fetch/clippy.tar.gz
RUN cd /fetch \
 && case "$ARCH/$(dpkg --print-architecture)" in \
      aarch64/arm64) printf '%s  %s\n' \
        7ccc960846f81e016086f1931dedadd837a3317da80e0114df68651145c0f43b rustc.tar.gz \
        b3acccbba065da7e97c20592442f104bd9554d54bf87a323bba8a1d6e61282eb cargo.tar.gz \
        89b01323a6611c9382a401282fb66eb80f1f3241df3e139d3df41afbd2da314b rust-std.tar.gz \
        e555f81eccd5e2f741732be3f6784d073946eadbf2e00f4112dfdabc6c36c13e rustfmt.tar.gz \
        41920025e43c858e777177468698a88fc270bcceb6ba61059aac1dfee4da1d37 clippy.tar.gz > sums ;; \
      x86_64/amd64) printf '%s  %s\n' \
        67b0e85ff4b3eee83c48b8ae1da10dd0bcd60b43d02cd0e7df78c59d19f6b960 rustc.tar.gz \
        4e7fc3cbe98e23c88a3c6ce37f834e3ffbc91536789782c4c4a9670df6b16a49 cargo.tar.gz \
        61eb09d68b338e230d698716927bd4623049c9910ef4a4972e66d763d66ed9e1 rust-std.tar.gz \
        b62ba6e046a5580c52f24a817101734b73e76ea0724fc6a21d57fba4db345ced rustfmt.tar.gz \
        277a9abd9378561d11fb67a9eb5c08895e207d07dfd985a67197aa47e030856f clippy.tar.gz > sums ;; \
      *) exit 1 ;; \
    esac \
 && sha256sum -c sums \
 && for c in rustc cargo rust-std rustfmt clippy; do \
      mkdir "$c" && tar -xzf "$c.tar.gz" -C "$c" --strip-components=1 --no-same-owner \
      && "$c/install.sh" --prefix=/opt/rust --disable-ldconfig > /dev/null || exit 1; \
    done \
 && rm -rf /opt/rust/share/doc /opt/rust/share/man /opt/rust/lib/rustlib/uninstall.sh /opt/rust/lib/rustlib/install.log

FROM ${BASE}
RUN apt-get -o Acquire::Check-Valid-Until=false update \
 && apt-get install -y --no-install-recommends gcc=4:12.2.0-3 gcc-12=12.2.0-14+deb12u1 libc6-dev=2.36-9+deb12u14 binutils=2.40-2 ca-certificates=20230311+deb12u1 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=fetch /opt/rust /opt/rust
RUN ln -s /opt/rust/bin/rustc /opt/rust/bin/rustdoc /opt/rust/bin/cargo /opt/rust/bin/rustfmt /opt/rust/bin/cargo-fmt /opt/rust/bin/cargo-clippy /opt/rust/bin/clippy-driver /usr/local/bin/
CMD ["sleep", "60"]
