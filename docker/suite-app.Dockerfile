FROM docker.io/library/debian:trixie-slim
ARG TARGETARCH

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl python3 make g++ git unzip ripgrep procps util-linux gnupg openssh-client && rm -rf /var/lib/apt/lists/*

# The image is built as one uid (root, at build time) and run as the host's
# uid (podman --userns=keep-id / docker --user, at run time, see
# run-suite-container.mjs) with the
# real git common dir bind-mounted in from the host at a THIRD ownership
# history — git's dubious-ownership guard reads that mismatch as tampering
# and refuses. `--system` (not `--global`) so the exemption applies
# regardless of which uid/HOME the container ends up running as.
RUN git config --system --add safe.directory '*'

ENV BUN_VERSION=1.4.4 \
    HERDR_VERSION=0.8.2 \
    OMP_VERSION=18.0.4 \
    BUN_INSTALL=/usr/local/bun \
    PATH=/usr/local/bun/bin:${PATH}

RUN case "${TARGETARCH}" in \
      amd64) bun_target=x64; herdr_target=x86_64; herdr_sha256=976150a14d490c94b243ea2e1a7eb2dfb67f12e36b182db90936f6728e6aecf4 ;; \
      arm64) bun_target=aarch64; herdr_target=aarch64; herdr_sha256=f55610658e1c2e0d2aaef730b4b2ab885f7f8ba00285ab372bfb14f2e3d5b40d ;; \
      *) echo "suite image: no bun and herdr binaries for architecture ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && curl --fail --location --silent --show-error --output /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${bun_target}.zip" \
    && unzip -q /tmp/bun.zip -d /tmp/bun \
    && install -D -m 0755 "/tmp/bun/bun-linux-${bun_target}/bun" /usr/local/bun/bin/bun \
    && mkdir -p "/opt/mise/installs/bun/${BUN_VERSION}/bin" \
    && ln -s /usr/local/bun/bin/bun "/opt/mise/installs/bun/${BUN_VERSION}/bin/bun" \
    && rm -rf /tmp/bun /tmp/bun.zip \
    && curl --fail --location --silent --show-error --output /usr/local/bin/herdr "https://github.com/herdrdev/herdr/releases/download/v${HERDR_VERSION}/herdr-linux-${herdr_target}" \
    && echo "${herdr_sha256}  /usr/local/bin/herdr" | sha256sum --check \
    && chmod 0755 /usr/local/bin/herdr

RUN bun install --global "@oh-my-pi/pi-coding-agent@${OMP_VERSION}"

WORKDIR /throne

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

RUN rm -rf .git \
    && git init --initial-branch=main \
    && git add --all \
    && git -c user.name="suite image" -c user.email="suite-image@localhost" commit --message="suite image source"

