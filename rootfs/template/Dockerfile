# BurstGrid rootfs Dockerfile template.
#
# Copy this file to a new folder and customise it for your workload:
#
#   cp -r rootfs/template rootfs/my-image
#   # edit rootfs/my-image/Dockerfile to add your tools
#   ./scripts/build-rootfs.sh rootfs/my-image/Dockerfile /opt/images/my-image.img 4G
#
# Register it in burstgrid.config.yaml:
#   worker:
#     images:
#       - name: my-image                       # label used in runs-on
#         path: /opt/images/my-image.img
#         description: "TODO: what is in this image"
#         os: ubuntu-22.04
#         tools: [git, curl]                   # TODO: list your tools
#
# Use it in a workflow:
#   runs-on: [self-hosted, burstgrid:image=my-image]

# ── 1. Choose your base OS ────────────────────────────────────────────────────
# Common choices:
#   ubuntu:22.04      — broad package support, good for most CI jobs
#   ubuntu:24.04      — newer toolchains
#   debian:bookworm-slim — smaller footprint
#   alpine:3.19       — minimal (requires musl-aware tooling)
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# ── 2. System packages ────────────────────────────────────────────────────────
# Always include: ca-certificates, curl, git, procps, libicu70, libssl3
# (the last two are required by the GitHub Actions runner binary)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl wget gnupg \
    git git-lfs \
    procps \
    libicu70 libssl3 \
    # TODO: add your packages here, e.g.:
    # python3 python3-pip \
    # build-essential \
    # jq unzip zip \
 && rm -rf /var/lib/apt/lists/*

# ── 3. (Optional) Docker daemon ───────────────────────────────────────────────
# Uncomment this block if your jobs use `docker build`, `docker run`, etc.
# Docker runs natively inside the Firecracker guest — no nested virtualisation needed.
#
# RUN install -m0755 -d /etc/apt/keyrings \
#  && curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
#     | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
#  && chmod a+r /etc/apt/keyrings/docker.gpg \
#  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
#     https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
#     > /etc/apt/sources.list.d/docker.list \
#  && apt-get update \
#  && apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io \
#  && rm -rf /var/lib/apt/lists/*

# ── 4. Language runtimes ──────────────────────────────────────────────────────
# Uncomment / adapt as needed.

# Node.js (via NodeSource):
# ARG NODE_VERSION=20
# RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - \
#  && apt-get install -y nodejs && rm -rf /var/lib/apt/lists/*
# RUN npm install -g pnpm

# Python (system package is fine for most jobs):
# RUN apt-get install -y python3 python3-pip python3-venv && rm -rf /var/lib/apt/lists/*

# Go:
# ARG GO_VERSION=1.22.4
# RUN curl -fsSL https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz \
#     | tar -C /usr/local -xz
# ENV PATH=$PATH:/usr/local/go/bin

# ── 5. Pre-warm caches ────────────────────────────────────────────────────────
# Anything slow to download at job-start time should be baked in here.
# e.g. Docker images, pip packages, npm packages, model weights, etc.
#
# RUN pip install torch==2.3.0 transformers==4.40.0
# RUN docker pull python:3.11-slim   # only works if Docker daemon is in the image

# ── 6. GitHub Actions runner ──────────────────────────────────────────────────
# Required. The runner binary handles communication with GitHub.
# Pin RUNNER_VERSION to a known-good release.
ARG RUNNER_VERSION=2.317.0
RUN mkdir -p /opt/actions-runner && cd /opt/actions-runner \
 && curl -fsSL "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" \
    | tar -xz \
 && ./bin/installdependencies.sh

# BurstGrid's vm-init.sh is injected at /sbin/burstgrid-init by build-rootfs.sh.
# It reads RUNNER_TOKEN + RUNNER_LABELS from /proc/cmdline and starts the runner.
