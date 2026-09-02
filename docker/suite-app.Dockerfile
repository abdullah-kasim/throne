# Sibling of suite.Dockerfile: that one builds the per-suite redis service,
# this one builds the container the suite's own `npm test` work runs inside.
# Build context is the repo root (see .dockerignore), unlike
# suite.Dockerfile's context of just docker/ — this image needs the whole
# repo baked in.
#
# The repo is COPYed in and `npm ci` runs INSIDE the build, rather than bind
# mounting the host's own node_modules, so native bindings (tree-sitter,
# tree-sitter-bash) are compiled against this image's own glibc instead of
# risking an ABI mismatch with the host's.
#
# node:22-bookworm (glibc, not alpine) because tree-sitter's native addon
# build needs a standard build toolchain, and bookworm's apt has it.
# Always built and run as linux/amd64 (run-suite-container.mjs passes
# --platform): the bun and herdr binaries below are x86_64 at pinned
# checksums, so an arm64 host runs this image under emulation rather than
# getting a silently mismatched binary.
FROM docker.io/library/node:22-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends curl python3 make g++ git unzip && rm -rf /var/lib/apt/lists/*

# The image is built as one uid (root, at build time) and run as the host's
# uid (podman --userns=keep-id / docker --user, at run time, see
# run-suite-container.mjs) with the
# real git common dir bind-mounted in from the host at a THIRD ownership
# history — git's dubious-ownership guard reads that mismatch as tampering
# and refuses. `--system` (not `--global`) so the exemption applies
# regardless of which uid/HOME the container ends up running as.
RUN git config --system --add safe.directory '*'

ENV BUN_VERSION=1.4.0 \
    HERDR_VERSION=0.8.2 \
    OMP_VERSION=18.0.4 \
    BUN_INSTALL=/usr/local/bun \
    PATH=/usr/local/bun/bin:${PATH}

RUN curl --fail --location --silent --show-error --output /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" \
    && unzip -q /tmp/bun.zip -d /tmp/bun \
    && install -D -m 0755 /tmp/bun/bun-linux-x64/bun /usr/local/bun/bin/bun \
    && rm -rf /tmp/bun /tmp/bun.zip

RUN curl --fail --location --silent --show-error --output /usr/local/bin/herdr "https://github.com/herdrdev/herdr/releases/download/v${HERDR_VERSION}/herdr-linux-x86_64" \
    && echo "976150a14d490c94b243ea2e1a7eb2dfb67f12e36b182db90936f6728e6aecf4  /usr/local/bin/herdr" | sha256sum --check \
    && chmod 0755 /usr/local/bin/herdr

RUN npm install --global "@oh-my-pi/pi-coding-agent@${OMP_VERSION}"

WORKDIR /throne

# Dependency manifests only, so this layer's cache key depends on what npm ci
# actually reads — not on the rest of the repo. An unrelated source change no
# longer busts the cached node_modules install.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

RUN rm -rf .git \
    && git init --initial-branch=main \
    && git add --all \
    && git -c user.name="suite image" -c user.email="suite-image@localhost" commit --message="suite image source"
# A handful of tests spawn real child processes against dist/, not the
# TypeScript source (test/fixtures/assert-compiled-fixture-runner-exists.ts
# fails them loudly rather than silently skipping if it's missing) — same
# requirement `npm test` already has on the host, just never satisfied by
# `npm test`'s own script. Baking it in at build time here, once, is cheaper
# than making every containerized run rebuild it.
RUN npm run build

# No ENTRYPOINT/CMD: scripts/run-suite-container.mjs always supplies the full
# suite command as the runtime's `run` trailing argv (e.g. `npm run test:no-lock`),
# so nothing here should assume or prepend an interpreter.
