# The fontego command in a container, for CI jobs and machines without Node or a desktop:
#
#   docker run --rm -e FONTEGO_URL=https://fontego.example.org -e FONTEGO_TOKEN -v "$PWD:/work" \
#     ghcr.io/fontego-ai/fontego clone handbook
#
# It holds the same single executable as a release (scripts/build.ts, so the flags are the same). Everything runs on
# the machine that builds the image: Bun cross-compiles for the image's architecture, and the last stage only copies
# files, so building for another architecture needs no emulation.
#   docker build -t fontego .
FROM --platform=$BUILDPLATFORM oven/bun:1.3.14-slim AS build
ARG TARGETARCH
WORKDIR /src
COPY package.json bun.lock ./
COPY core/package.json core/
COPY cli/package.json cli/
RUN bun install --production --frozen-lockfile
COPY . .
RUN case "$TARGETARCH" in \
      amd64) target=linux-x64 ;; \
      arm64) target=linux-arm64 ;; \
      *) echo "error: no fontego executable for linux/$TARGETARCH" >&2; exit 1 ;; \
    esac \
    && bun scripts/build.ts --only "$target" --out /out \
    && install -D -m 755 "/out/release/fontego-$target" /rootfs/usr/local/bin/fontego
# The image's user, added to the base image's own account files, and its two folders.
COPY --from=debian:13-slim /etc/passwd /etc/group /rootfs/etc/
RUN echo "fontego:x:1000:1000::/home/fontego:/bin/sh" >>/rootfs/etc/passwd \
    && echo "fontego:x:1000:" >>/rootfs/etc/group \
    && install -d -m 700 /rootfs/home/fontego && install -d -m 755 /rootfs/work

# A small Debian with a shell, so CI systems that run their steps through sh can use the image as it is. The
# executable needs only glibc, and brings its own root certificates.
FROM debian:13-slim
COPY --from=build /rootfs/etc/passwd /rootfs/etc/group /etc/
COPY --from=build --chown=1000:1000 /rootfs/home/ /home/
COPY --from=build --chown=1000:1000 /rootfs/work /work
COPY --from=build /rootfs/usr/local/bin/fontego /usr/local/bin/fontego
COPY LICENSE NOTICE /usr/share/doc/fontego/
LABEL org.opencontainers.image.title="fontego" \
      org.opencontainers.image.description="The fontego command: sign in to a Fontego server, explore its workspaces and keep a folder in sync" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/fontego-ai/fontego-cli"
# No keychain in a container: a `fontego login` keeps its credentials in ~/.config/fontego/credentials.json (0600).
# Mount a volume on /home/fontego/.config/fontego to keep them, or pass FONTEGO_URL and FONTEGO_TOKEN instead.
ENV FONTEGO_CREDENTIAL_STORE=file
USER fontego
WORKDIR /work
ENTRYPOINT ["fontego"]
CMD ["help"]
