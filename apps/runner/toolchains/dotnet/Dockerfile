# Runner's .NET toolchain image (the owner's ruling of 2026-11-20: no single large task image; a room chooses optional,
# pinned toolchains in its run policy, `"toolchains": ["dotnet"]`). It is built FROM Runner's base task image, which
# Runner passes as BASE (a tag on its image ID; Runner then checks the result's layers start with that image's), so
# everything in apps/runner/sandbox (shell tools, Node 22) is here too:
#
#   docker build -q --pull=false --build-arg BASE=<task image> --build-arg ARCH=<arm64|x64> apps/runner/toolchains/dotnet
#
# Runner builds and pins it itself the first time a room needs it (`toolchain-image-dotnet` in Runner's home), so this
# is never the owner's to run by hand. It holds no key or secret.
#
# What it adds: the .NET SDK 10.0.404 (.NET 10, the current LTS; runtime 10.0.15, released 2026-11-10), from
# Microsoft's official linux tarball on builds.dotnet.microsoft.com, unpacked read-only into /opt/dotnet and linked as
# dotnet in /usr/local/bin. Its bundled templates and targeting packs are enough to create and build a project with no
# package references offline. Runner passes ARCH, the Docker Engine's architecture as .NET names it (arm64 or x64), so
# only that architecture's tarball is fetched, with either of Docker's builders; the build stops unless it matches both
# the fetch stage's architecture and the base image's, checked in each stage. Each tarball's SHA-512 is written here and
# checked with `sha512sum -c`; the build never trusts a checksum file it fetches. The sums were read 2026-11-20 from
# Microsoft's release metadata for .NET 10.0, releases.json on builds.dotnet.microsoft.com (release 10.0.15, sdk
# 10.0.404), fetched over HTTPS; the same file in the dotnet/core GitHub repository (release-notes/10.0/releases.json)
# lists the same sums, and the downloaded tarballs matched them.
#
# .NET needs ICU for globalization and OpenSSL for TLS and cryptography, so libicu72, libssl3 and ca-certificates (with
# openssl, which ca-certificates needs) come from the base image's snapshot.debian.org timestamp at exact versions.
# ICU is installed rather than turning on invariant globalization, so culture-aware code and tests behave as they do on
# an ordinary Linux install. zlib, libstdc++, libgcc and tzdata are already in the base image.
#
# The SDK's workloads are marked user-local for its feature band (metadata/workloads/10.0.400/userlocal), so the SDK keeps
# workload state under the CLI's home in /work and never tries to write to /opt/dotnet, which is read-only at run time
# (without it every `dotnet new` warns that it couldn't verify workloads).
#
# At run time Runner's fixed environment for a .NET room turns off telemetry, the logo, the first-run experience and
# the ASP.NET development certificate, puts the CLI's home at /work/.cache/dotnet and NuGet's packages at
# /work/.cache/nuget/packages, sets DOTNET_ROOT so a built program's own launcher finds the runtime, and keeps MSBuild
# and the compiler from leaving server processes behind after a command. NuGet's own data (~/.local/share/NuGet) and
# the runtime's named mutexes' shared memory (~/.dotnet/corefx, kept under HOME whatever else is set) follow HOME,
# which Runner sets to /work/.cache/home for every room. Builds go to each project's own bin and obj
# folders under /work. NuGet reaches api.nuget.org through HTTPS_PROXY, which .NET reads, when the room's network lists it.
ARG BASE
ARG ARCH

FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc AS fetch
ARG ARCH
ADD https://builds.dotnet.microsoft.com/dotnet/Sdk/10.0.404/dotnet-sdk-10.0.404-linux-${ARCH}.tar.gz /fetch/dotnet.tar.gz
RUN cd /fetch \
 && case "$ARCH/$(dpkg --print-architecture)" in \
      arm64/arm64) printf '%s  %s\n' \
        3533a3869da219cac45c567aadac3d8e96cdf1c6a04fe1c1d5fdeefea5d45af8424488f0144730d11b4a751f7ad546fb11e4c2b2725cd8401efee726711f8f11 dotnet.tar.gz > sums ;; \
      x64/amd64) printf '%s  %s\n' \
        577d0eb17fec33d029104c5c63a1ab0accc3e28776274abef2218dbac5af18d2109b5406d26b31d76f5c245215e3ba0926a94c20246c672c41847c9e1eb1dc50 dotnet.tar.gz > sums ;; \
      *) exit 1 ;; \
    esac \
 && sha512sum -c sums \
 && mkdir -p /opt/dotnet \
 && tar -xzf dotnet.tar.gz -C /opt/dotnet --no-same-owner \
 && test -x /opt/dotnet/dotnet \
 && test -d /opt/dotnet/sdk/10.0.404 \
 && test -d /opt/dotnet/shared/Microsoft.NETCore.App/10.0.15 \
 && mkdir -p /opt/dotnet/metadata/workloads/10.0.400 \
 && touch /opt/dotnet/metadata/workloads/10.0.400/userlocal

FROM ${BASE}
ARG ARCH
RUN case "$ARCH/$(dpkg --print-architecture)" in arm64/arm64|x64/amd64) ;; *) exit 1 ;; esac \
 && apt-get -o Acquire::Check-Valid-Until=false update \
 && apt-get install -y --no-install-recommends libicu72=72.1-3+deb12u1 libssl3=3.0.20-1~deb12u2 openssl=3.0.20-1~deb12u2 ca-certificates=20230311+deb12u1 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=fetch /opt/dotnet /opt/dotnet
RUN ln -s /opt/dotnet/dotnet /usr/local/bin/dotnet
CMD ["sleep", "60"]
