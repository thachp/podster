# Runner's Java toolchain image (the owner's ruling of 2026-11-20: no single large task image; a room chooses optional,
# pinned toolchains in its run policy, `"toolchains": ["java"]`). It is built FROM Runner's base task image, which
# Runner passes as BASE (a tag on its image ID; Runner then checks the result's layers start with that image's), so
# everything in apps/runner/sandbox (shell tools, Node 22) is here too:
#
#   docker build -q --pull=false --build-arg BASE=<task image> --build-arg ARCH=<aarch64|x64> apps/runner/toolchains/java
#
# Runner builds and pins it itself the first time a room needs it (`toolchain-image-java` in Runner's home), so this is
# never the owner's to run by hand. It holds no key or secret.
#
# What it adds: the Eclipse Temurin JDK 25.0.5.1+2 (Java 25, the current LTS), from Adoptium's GitHub release tarball,
# in /opt/java/jdk, and Apache Maven 3.10.1, from Maven Central (repo.maven.apache.org), in /opt/java/maven; the JDK's programs and mvn are
# linked into /usr/local/bin. There is no Gradle: a Gradle project uses its own wrapper, which fetches Gradle from
# services.gradle.org when the room's network lists it. Runner passes ARCH, the Docker Engine's architecture as
# Temurin names it (aarch64 or x64), so only that architecture's JDK is fetched, with either of Docker's builders; the
# build stops unless it matches both the fetch stage's architecture and the base image's, checked in each stage.
#
# Each tarball's checksum is written here and checked with `sha256sum -c` and `sha512sum -c`; the build never trusts a
# checksum file it fetches. Read 2026-11-20:
# - the JDK's SHA-256s from Adoptium's API (api.adoptium.net, assets/latest/25/hotspot), after each downloaded tarball's
#   detached signature (its .sig on the GitHub release) was checked against the Adoptium key
#   3B04 D753 C905 0D9A 5D34 3F39 843C 48A5 65F8 F04B, the same key on keyserver.ubuntu.com and on Adoptium's own
#   packages.adoptium.net; the release's own .sha256.txt files list the same sums;
# - Maven's SHA-512 from its .sha512 on archive.apache.org, after the tarball's detached signature (.asc) was checked
#   against Apache Maven's KEYS file (the same on downloads.apache.org and archive.apache.org): it is signed by
#   Tamas Cservenak's key 88BE 34F9 4BDB 2B53 5704 4E2E 3A38 7D43 9641 43E3, a Maven release manager listed in KEYS.
#   Maven is fetched from Maven Central, Apache's own repository for Maven's artifacts, which serves the same tarball
#   (org/apache/maven/apache-maven/3.10.1, -bin.tar.gz): its SHA-512 there, read 2026-11-24, is the one above, and so is
#   its .sha512. It was archive.apache.org until 2026-11-24, which is slow and rate-limits, and failed a CI build.
#
# Java and Maven don't read HTTPS_PROXY, which Runner sets for a room whose network lists hosts, so the image points
# both at Runner's egress proxy (`egress`, port 3128) itself: the JDK's conf/net.properties sets http(s).proxyHost and
# proxyPort, which every JVM reads (the Gradle wrapper and Gradle's own downloads included), and Maven's global
# conf/settings.xml lists the same proxy, since Maven's resolver ignores the JVM's proxy properties. In a run with no
# network the name `egress` doesn't resolve, so this reaches nothing. localhost, 127.* and ::1 are never proxied (the
# JDK's own default `http.nonProxyHosts`, localhost|127.*|[::1], which its HTTPS handlers use too, and the same in
# Maven's list); a call to the container's own host name is proxied, and the proxy refuses it, so tests use localhost.
#
# Temurin carries its own CA certificates, so no Debian package is added. At run time Runner's fixed environment for a
# Java room sets JAVA_HOME and points Maven's local repository at /work/.cache/m2/repository (MAVEN_OPTS) and the
# Gradle wrapper's home at /work/.cache/gradle (GRADLE_USER_HOME). Anything else a JVM keeps under the user's home
# (a Maven wrapper's ~/.m2/wrapper, java.util.prefs' ~/.java, Kotlin's ~/.local/share/kotlin) follows HOME, which
# Runner sets to /work/.cache/home for every room; with no passwd entry for the task's user, the JDK's user.home is HOME. Builds go to each project's own target or build
# folder under /work.
ARG BASE
ARG ARCH

FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc AS fetch
ARG ARCH
ADD https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.5.1%2B2/OpenJDK25U-jdk_${ARCH}_linux_hotspot_25.0.5.1_2.tar.gz /fetch/jdk.tar.gz
ADD https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.10.1/apache-maven-3.10.1-bin.tar.gz /fetch/maven.tar.gz
RUN cd /fetch \
 && case "$ARCH/$(dpkg --print-architecture)" in \
      aarch64/arm64) printf '%s  %s\n' \
        c37879e0d08eeb1baa69fcbb7758cd455b7b1c0ceab1e2a136ccb1713c530984 jdk.tar.gz > sums ;; \
      x64/amd64) printf '%s  %s\n' \
        760f91b22c3efc9bd1b64ff950598231be82928cc807e30691a0e7a2995a62c0 jdk.tar.gz > sums ;; \
      *) exit 1 ;; \
    esac \
 && sha256sum -c sums \
 && printf '%s  %s\n' \
      8af2fcc48ee6b8f8fc0b21054226e14404b88500df6483cdeb3ae603408f6de27b1397ac591a9fb0d98fee64f4f624fee1383efd25b8998786cda1598fb9ea39 maven.tar.gz > sums512 \
 && sha512sum -c sums512 \
 && mkdir -p /opt/java/jdk /opt/java/maven \
 && tar -xzf jdk.tar.gz -C /opt/java/jdk --strip-components=1 --no-same-owner \
 && tar -xzf maven.tar.gz -C /opt/java/maven --strip-components=1 --no-same-owner \
 && test -x /opt/java/jdk/bin/javac \
 && test -x /opt/java/maven/bin/mvn \
 && printf '%s\n' 'http.proxyHost=egress' 'http.proxyPort=3128' 'https.proxyHost=egress' 'https.proxyPort=3128' >> /opt/java/jdk/conf/net.properties \
 && printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' \
      '<settings xmlns="http://maven.apache.org/SETTINGS/1.2.0">' \
      '  <proxies>' \
      '    <proxy><id>runner-egress-https</id><active>true</active><protocol>https</protocol><host>egress</host><port>3128</port><nonProxyHosts>localhost|127.*|::1|[::1]</nonProxyHosts></proxy>' \
      '    <proxy><id>runner-egress-http</id><active>true</active><protocol>http</protocol><host>egress</host><port>3128</port><nonProxyHosts>localhost|127.*|::1|[::1]</nonProxyHosts></proxy>' \
      '  </proxies>' \
      '</settings>' > /opt/java/maven/conf/settings.xml

FROM ${BASE}
ARG ARCH
RUN case "$ARCH/$(dpkg --print-architecture)" in aarch64/arm64|x64/amd64) ;; *) exit 1 ;; esac
COPY --from=fetch /opt/java /opt/java
RUN ln -s /opt/java/jdk/bin/* /usr/local/bin/ \
 && ln -s /opt/java/maven/bin/mvn /usr/local/bin/mvn
CMD ["sleep", "60"]
