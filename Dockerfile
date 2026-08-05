# syntax=docker/dockerfile:1
#
# cc-docker — Claude Code inside a container, wired to the local environment.
#
# The image intentionally ships a *general purpose* dev userland: Claude Code
# routinely shells out to git/rg/jq/python/node, and a stripped image turns
# every such call into a puzzling failure inside the container.

FROM node:22-bookworm-slim

# `latest`, or a pinned Claude Code version such as 2.1.222
ARG CLAUDE_VERSION=latest
# Space separated extra apt packages, e.g. --build-arg EXTRA_APT_PACKAGES="postgresql-client"
ARG EXTRA_APT_PACKAGES=""

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PATH=/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ca-certificates curl wget gnupg openssh-client \
      git git-lfs \
      ripgrep fd-find jq less nano \
      procps psmisc lsof iproute2 net-tools \
      python3 python3-venv python3-pip \
      build-essential pkg-config \
      unzip zip xz-utils bzip2 \
      locales tini gosu sudo bash-completion \
      $EXTRA_APT_PACKAGES; \
    ln -sf /usr/bin/fdfind /usr/local/bin/fd; \
    rm -rf /var/lib/apt/lists/*

# uv / uvx — a large share of stdio MCP servers are distributed as `uvx <pkg>`.
RUN set -eux; \
    curl -LsSf https://astral.sh/uv/install.sh \
      | env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh; \
    uv --version; uvx --version

# Claude Code itself. Installed under /opt so that it is owned by root and
# shared by every runtime user; the auto-updater is disabled because the image
# is immutable (use `doclaude self rebuild` to move to a newer version).
ENV CLAUDE_INSTALL_HOME=/opt/claude
RUN set -eux; \
    mkdir -p "$CLAUDE_INSTALL_HOME"; \
    if [ "$CLAUDE_VERSION" = "latest" ]; then \
      curl -fsSL https://claude.ai/install.sh | env HOME="$CLAUDE_INSTALL_HOME" bash; \
    else \
      curl -fsSL https://claude.ai/install.sh | env HOME="$CLAUDE_INSTALL_HOME" bash -s -- "$CLAUDE_VERSION"; \
    fi; \
    ln -sf "$CLAUDE_INSTALL_HOME/.local/bin/claude" /usr/local/bin/claude; \
    chmod -R a+rX "$CLAUDE_INSTALL_HOME"; \
    /usr/local/bin/claude --version

# doclaude runtime: entrypoint, host bridge client, PATH shims.
# `shared/` is copied separately because the wire protocol is shared verbatim
# with the host agent and must not drift between the two.
COPY container/ /opt/doclaude/
COPY shared/ /opt/doclaude/shared/
RUN set -eux; \
    chmod +x /opt/doclaude/entrypoint.sh \
             /opt/doclaude/run-user.sh \
             /opt/doclaude/bin/*.mjs \
             /opt/doclaude/shims/host-cmd; \
    ln -sf /opt/doclaude/bin/ccd-mcp.mjs  /usr/local/bin/ccd-mcp; \
    ln -sf /opt/doclaude/bin/ccd-open.mjs /usr/local/bin/ccd-open; \
    ln -sf /opt/doclaude/bin/ccd-host.mjs /usr/local/bin/ccd-host; \
    ln -sf /opt/doclaude/bin/ccd-probe.mjs /usr/local/bin/ccd-probe; \
    ln -sf /opt/doclaude/bin/ccd-open.mjs /usr/local/bin/xdg-open; \
    ln -sf /opt/doclaude/bin/ccd-open.mjs /usr/local/bin/sensible-browser; \
    ln -sf /opt/doclaude/bin/ccd-open.mjs /usr/local/bin/www-browser; \
    ln -sf /opt/doclaude/bashenv.sh       /etc/profile.d/doclaude.sh; \
    node --input-type=module -e 'import("/opt/doclaude/lib/client.mjs")' >/dev/null

# `docker inspect` friendliness / marker used by `doclaude self doctor`.
LABEL org.opencontainers.image.title="cc-docker" \
      org.opencontainers.image.description="Claude Code in Docker with live access to the local environment" \
      org.opencontainers.image.source="https://github.com/cc-docker/cc-docker"

ENV DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=0 \
    DOCLAUDE_IN_CONTAINER=1

ENTRYPOINT ["/usr/bin/tini", "--", "/opt/doclaude/entrypoint.sh"]
CMD []
