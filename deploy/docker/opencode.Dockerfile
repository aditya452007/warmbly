# syntax=docker/dockerfile:1
#
# Headless OpenCode server (the AI agent runtime the bridge drives over HTTP).
#
# There is no official OpenCode container image (the historical
# ghcr.io/sst/opencode registry path is denied), so this builds one from the
# official standalone binary release pinned at build time. The binary is a
# self-contained Bun executable and does not need the Node runtime — but the
# node base keeps the toolchain small, matches the rest of this stack, and
# gives the healthcheck a runtime for its probe.
#
# The bridge connects with OPENCODE_BASE_URL=http://opencode:4096 on the
# compose network; nothing is published to the host by default. Server flags
# and basic auth per https://opencode.ai/docs/server/.
#
# Override the pin at build time: --build-arg OPENCODE_VERSION=1.18.26
# (matching the bridge's @opencode-ai/sdk) or "latest".

FROM node:24-alpine

ARG OPENCODE_VERSION=1.18.26
ARG TARGETARCH

RUN apk add --no-cache curl bash \
    # The install script wants unzip for the standalone binary and git so the
    # agent can read repository state (a coding agent without git is a text
    # generator with opinions).
    unzip git \
    && curl -fsSL https://opencode.ai/install | bash -s -- --version ${OPENCODE_VERSION} \
    # The script installs to $HOME/.opencode/bin with a versioned directory
    # beside it; normalize onto PATH for any user.
    && ln -sf /root/.opencode/bin/opencode /usr/local/bin/opencode \
    && opencode --version

# OpenCode stores sessions and state under ~/.local/share/opencode (XDG). Run
# as a dedicated user so the compose volume has a known owner.
RUN addgroup -S opencode && adduser -S -G opencode -h /home/opencode opencode \
    && mkdir -p /home/opencode/.local/share/opencode \
    && chown -R opencode:opencode /home/opencode
USER opencode
WORKDIR /home/opencode
ENV XDG_DATA_HOME=/home/opencode/.local/share

EXPOSE 4096

# Auth comes from OPENCODE_SERVER_USERNAME / OPENCODE_SERVER_PASSWORD env at
# run time (compose injects both into this container and the bridge, so they
# always agree). Bind 0.0.0.0: the compose network is the only access path.
ENTRYPOINT ["opencode"]
CMD ["serve", "--hostname", "0.0.0.0", "--port", "4096"]
