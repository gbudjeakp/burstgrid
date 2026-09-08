# Bakes a worker AMI with Firecracker, the GitHub Actions runner, vmlinux, and
# the default rootfs.img already embedded — so userdata.sh.tpl's S3 downloads
# are skipped entirely and workers reach "ready" in seconds instead of ~60-90s.
#
# Usage:
#   packer init deploy/packer/worker-ami.pkr.hcl
#   packer build \
#     -var "s3_artifacts_bucket=my-burstgrid-bucket" \
#     -var "region=us-east-1" \
#     -var "source_ami=ami-xxxxxxxx" \
#     deploy/packer/worker-ami.pkr.hcl
#
# The resulting AMI ID goes into terraform.tfvars as worker_ami. Rebuild and
# redeploy whenever rootfs.img, vmlinux, or the runner version changes —
# nothing here auto-updates (same tradeoff Karpenter's AMI drift detection
# solves in Kubernetes; there's no equivalent watcher here, it's a manual step).

packer {
  required_plugins {
    amazon = {
      version = ">= 1.3.0"
      source   = "github.com/hashicorp/amazon"
    }
  }
}

variable "region"              { type = string }
variable "source_ami"          { type = string } # stock Ubuntu 24.04 ARM64 AMI
variable "instance_type" {
  type    = string
  default = "c6g.large" # build host only — bare metal not needed to bake the image
}
variable "s3_artifacts_bucket" { type = string }
variable "firecracker_version" {
  type    = string
  default = "v1.16.1"
}
variable "runner_version" {
  type    = string
  default = "2.319.1"
}

source "amazon-ebs" "worker" {
  region        = var.region
  source_ami    = var.source_ami
  instance_type = var.instance_type
  ssh_username  = "ubuntu"
  ami_name      = "burstgrid-worker-{{timestamp}}"
  ami_description = "BurstGrid worker - pre-baked Firecracker + runner + vmlinux + rootfs.img"
  tags = {
    Name              = "burstgrid-worker-baked"
    "burstgrid:role"  = "runner-ami"
  }
}

build {
  sources = ["source.amazon-ebs.worker"]

  provisioner "shell" {
    environment_vars = [
      "S3_BUCKET=${var.s3_artifacts_bucket}",
      "FIRECRACKER_VERSION=${var.firecracker_version}",
      "RUNNER_VERSION=${var.runner_version}",
    ]
    inline = [
      "set -euo pipefail",
      "export DEBIAN_FRONTEND=noninteractive",
      "sudo apt-get update -y",
      "sudo apt-get install -y --no-install-recommends curl ca-certificates unzip git jq build-essential libssl-dev iproute2 iptables",

      # AWS CLI v2 (ARM64)
      "curl -fsSL https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip -o /tmp/awscliv2.zip",
      "unzip -q /tmp/awscliv2.zip -d /tmp/awscliv2",
      "sudo /tmp/awscliv2/aws/install",
      "rm -rf /tmp/awscliv2 /tmp/awscliv2.zip",

      # Firecracker binary
      "curl -fsSL https://github.com/firecracker-microvm/firecracker/releases/download/$FIRECRACKER_VERSION/firecracker-$FIRECRACKER_VERSION-aarch64.tgz | tar -xz -C /tmp",
      "sudo install -m755 /tmp/release-$FIRECRACKER_VERSION-aarch64/firecracker-$FIRECRACKER_VERSION-aarch64 /usr/local/bin/firecracker",
      "rm -rf /tmp/release-$FIRECRACKER_VERSION-aarch64",

      # Node.js 24 (worker-agent runtime)
      "curl -fsSL https://deb.nodesource.com/setup_24.x | sudo bash -",
      "sudo apt-get install -y nodejs",

      # GitHub Actions runner
      "sudo mkdir -p /opt/actions-runner && cd /opt/actions-runner",
      "curl -fsSLO https://github.com/actions/runner/releases/download/v$RUNNER_VERSION/actions-runner-linux-arm64-$RUNNER_VERSION.tar.gz",
      "sudo tar xzf actions-runner-linux-arm64-$RUNNER_VERSION.tar.gz",
      "sudo ./bin/installdependencies.sh",
      "rm -f actions-runner-linux-arm64-$RUNNER_VERSION.tar.gz",

      # vmlinux + default rootfs.img baked in - userdata.sh.tpl skips S3 if these exist
      "sudo mkdir -p /var/lib/burstgrid",
      "VMLINUX_KEY=vmlinux-aarch64",
      "/usr/local/bin/aws s3 cp s3://$S3_BUCKET/$VMLINUX_KEY /var/lib/burstgrid/vmlinux || { VMLINUX_KEY=vmlinux; /usr/local/bin/aws s3 cp s3://$S3_BUCKET/$VMLINUX_KEY /var/lib/burstgrid/vmlinux; }",
      "/usr/local/bin/aws s3 cp s3://$S3_BUCKET/rootfs-arm64.img.gz /tmp/rootfs.img.gz",
      "gunzip -c /tmp/rootfs.img.gz | sudo tee /var/lib/burstgrid/rootfs.img > /dev/null",
      "rm /tmp/rootfs.img.gz",

      # Record the exact S3 object versions baked in, so userdata.sh.tpl can detect drift
      # at boot (S3 updated since this AMI was built) and re-download only what's stale
      # instead of silently trusting a possibly-outdated baked copy. Firecracker itself
      # isn't tracked here — it's pinned by firecracker_version and fetched from GitHub,
      # not iterated on in S3 the way rootfs.img/vmlinux are.
      "VMLINUX_ETAG=$(/usr/local/bin/aws s3api head-object --bucket $S3_BUCKET --key $VMLINUX_KEY --query ETag --output text | tr -d '\\"')",
      "ROOTFS_ETAG=$(/usr/local/bin/aws s3api head-object --bucket $S3_BUCKET --key rootfs-arm64.img.gz --query ETag --output text | tr -d '\\"')",
      "printf 'vmlinux=%s\\nrootfs=%s\\n' \"$VMLINUX_ETAG\" \"$ROOTFS_ETAG\" | sudo tee /var/lib/burstgrid/.baked-versions > /dev/null",
    ]
  }

  # Writes manifest.json with the resulting AMI ID so `burstgrid bake-ami` can
  # pick it up and write it into terraform.tfvars automatically.
  post-processor "manifest" {
    output      = "manifest.json"
    strip_path  = true
  }
}
