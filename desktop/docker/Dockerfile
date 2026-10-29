FROM ubuntu:22.04@sha256:8a2321a92b438238f93b4346fff61bc4259c99fdd4d9b52ee86f153fee0c344f

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git openssh-client build-essential pkg-config python3 \
    libwebkit2gtk-4.1-dev libssl-dev libxdo-dev \
    libayatana-appindicator3-dev librsvg2-dev patchelf file libatomic1 \
    && rm -rf /var/lib/apt/lists/*

# Use the same checksum-pinned Node runtime as the Linux desktop payload.
COPY runtime-lock.json /opt/runlist/runtime-lock.json
RUN python3 -c 'import json; p=json.load(open("/opt/runlist/runtime-lock.json")); n=p["platforms"]["linux"]["x64"]; print(p["version"],n["file"],n["sha256"])' > /tmp/node-pin \
    && read node_version node_file node_sha < /tmp/node-pin \
    && curl -fsSL "https://nodejs.org/dist/$node_version/$node_file" -o /tmp/node.tar.gz \
    && printf '%s  /tmp/node.tar.gz\n' "$node_sha" | sha256sum -c - \
    && mkdir /opt/node && tar -xzf /tmp/node.tar.gz -C /opt/node --strip-components=1 \
    && rm /tmp/node.tar.gz /tmp/node-pin
ENV PATH=/opt/node/bin:/opt/cargo/bin:$PATH \
    RUSTUP_HOME=/opt/rustup RUSTUP_TOOLCHAIN=1.95.0
RUN curl -fsSL https://static.rust-lang.org/rustup/archive/1.28.2/x86_64-unknown-linux-gnu/rustup-init -o /tmp/rustup-init \
    && echo '20a06e644b0d9bd2fbdbfd52d42540bdde820ea7df86e92e533c073da0cdd43c  /tmp/rustup-init' | sha256sum -c - \
    && chmod +x /tmp/rustup-init \
    && CARGO_HOME=/opt/cargo /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain 1.95.0 \
    && rm /tmp/rustup-init \
    && chmod -R a+rX /opt/cargo /opt/rustup

COPY validate.sh /opt/runlist/validate.sh
ARG BUILD_UID=1000
ARG BUILD_GID=1000
RUN groupadd --gid "$BUILD_GID" runlist \
    && useradd --uid "$BUILD_UID" --gid "$BUILD_GID" --home-dir /tmp/runlist-home --no-create-home runlist
ENV HOME=/tmp/runlist-home CARGO_HOME=/cache/cargo \
    XDG_CACHE_HOME=/cache/xdg npm_config_cache=/cache/npm \
    CARGO_BUILD_JOBS=2 APPIMAGE_EXTRACT_AND_RUN=1
WORKDIR /tmp
# The runner overrides this with the calling user's numeric UID/GID.
USER runlist
ENTRYPOINT ["bash", "/opt/runlist/validate.sh"]
