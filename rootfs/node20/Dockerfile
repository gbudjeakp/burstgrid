# Ubuntu 22.04 + Node 20 LTS (no Docker) rootfs for Firecracker microVMs.
#
# Build:
#   ./scripts/build-rootfs.sh rootfs/node20/Dockerfile /opt/images/node20.img 3G
#
# Register in burstgrid.config.yaml:
#   worker:
#     images:
#       - name: node20
#         path: /opt/images/node20.img
#         description: "Ubuntu 22.04 + Node 20 LTS + pnpm"
#         os: ubuntu-22.04
#         languages: { node: "20.x" }
#         tools: [node, npm, pnpm, git, curl]
#
# Use in a workflow:
#   runs-on: [self-hosted, burstgrid:image=node20]

FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg git git-lfs unzip jq \
    procps libicu70 libssl3 \
 && rm -rf /var/lib/apt/lists/*

# Install Node 20 via NodeSource
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y nodejs \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm

# Install GitHub Actions runner
ARG RUNNER_VERSION=2.317.0
RUN mkdir -p /opt/actions-runner && cd /opt/actions-runner \
 && curl -fsSL "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" \
    | tar -xz \
 && ./bin/installdependencies.sh
