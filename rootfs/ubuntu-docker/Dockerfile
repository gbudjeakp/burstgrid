# Ubuntu 22.04 + Docker 24 rootfs for Firecracker microVMs.
#
# Build:
#   ./scripts/build-rootfs.sh rootfs/ubuntu-docker/Dockerfile /opt/images/ubuntu-docker.img 4G
#
# Then register in burstgrid.config.yaml:
#   worker:
#     images:
#       - name: ubuntu-docker
#         path: /opt/images/ubuntu-docker.img
#         description: "Ubuntu 22.04 + Docker 24 + git + curl"
#         os: ubuntu-22.04
#         tools: [docker, git, curl, unzip, jq]
#         docker_version: "24.0"
#
# Use in a workflow:
#   runs-on: [self-hosted, burstgrid:image=ubuntu-docker]

FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    # core utilities
    ca-certificates curl wget gnupg lsb-release \
    git git-lfs unzip zip jq \
    # process tools
    procps psmisc iproute2 iputils-ping \
    # needed by the runner
    libicu70 libssl3 \
 && rm -rf /var/lib/apt/lists/*

# Install Docker CE
RUN install -m0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
 && chmod a+r /etc/apt/keyrings/docker.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
    https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
    > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io \
 && rm -rf /var/lib/apt/lists/*

# Install GitHub Actions runner — arch-aware (amd64 → x64, arm64 → arm64)
ARG TARGETARCH=amd64
ARG RUNNER_VERSION=2.317.0
RUN RUNNER_ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "arm64" || echo "x64") \
 && mkdir -p /opt/actions-runner && cd /opt/actions-runner \
 && curl -fsSL "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-${RUNNER_ARCH}-${RUNNER_VERSION}.tar.gz" \
    | tar -xz \
 && ./bin/installdependencies.sh

# BurstGrid init script is injected by build-rootfs.sh at /sbin/burstgrid-init
