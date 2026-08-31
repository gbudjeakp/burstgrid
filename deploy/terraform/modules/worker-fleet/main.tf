variable "vpc_id" { type = string }
variable "subnet_ids" { type = list(string) }
variable "ami" { type = string }
variable "scheduler_url" { type = string }
variable "worker_token" {
  type      = string
  sensitive = true
}
variable "s3_artifacts_bucket" { type = string }
variable "aws_region" { type = string }
variable "tags" {
  type    = map(string)
  default = {}
}

variable "fleets" {
  type = list(object({
    name               = string
    instance_type      = string
    slots_per_worker   = number
    max_workers        = number
    scale_up_threshold = optional(number, 1)
    capacity_type      = optional(string, "spot")
  }))
}

# ── Security group ────────────────────────────────────────────────────────────
# Workers make outbound connections only (to scheduler, GitHub, AWS APIs, apt).
# No inbound needed — the scheduler connects inward via the worker's SSE stream.

resource "aws_security_group" "worker" {
  name_prefix = "burstgrid-worker-"
  vpc_id      = var.vpc_id
  description = "BurstGrid worker - egress only"

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, { Name = "burstgrid-worker" })
}

# ── IAM role ──────────────────────────────────────────────────────────────────

resource "aws_iam_role" "worker" {
  name_prefix = "burstgrid-worker-"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Action = "sts:AssumeRole", Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" } }]
  })
  tags = var.tags
}

resource "aws_iam_role_policy" "worker" {
  name = "burstgrid-worker"
  role = aws_iam_role.worker.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Download the worker-agent binary at boot
        Sid      = "S3Artifacts"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:ListBucket"]
        Resource = ["arn:aws:s3:::${var.s3_artifacts_bucket}", "arn:aws:s3:::${var.s3_artifacts_bucket}/*"]
      },
      {
        # Poll the spot interruption queue so the worker-agent can drain gracefully
        Sid      = "SpotQueue"
        Effect   = "Allow"
        Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
        Resource = aws_sqs_queue.spot_interruptions.arn
      },
      {
        # Worker self-terminates when all slots are idle (no scheduler call needed)
        Sid      = "SelfTerminate"
        Effect   = "Allow"
        Action   = "ec2:TerminateInstances"
        Resource = "*"
        Condition = {
          StringEquals = { "ec2:ResourceTag/burstgrid:role" = "runner" }
        }
      },
      {
        # Tag self at boot for the SelfTerminate condition above
        Sid      = "SelfTag"
        Effect   = "Allow"
        Action   = "ec2:CreateTags"
        Resource = "*"
      },
    ]
  })
}

# SSM allows ops access without SSH key pairs
resource "aws_iam_role_policy_attachment" "worker_ssm" {
  role       = aws_iam_role.worker.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "worker" {
  name_prefix = "burstgrid-worker-"
  role        = aws_iam_role.worker.name
}

# ── SQS queue: spot interruption warnings ─────────────────────────────────────
# EC2 Spot interruption notice → EventBridge → SQS → worker-agent (graceful drain)

resource "aws_sqs_queue" "spot_interruptions" {
  name                       = "burstgrid-spot-interruptions"
  message_retention_seconds  = 300 # 2-minute warning; 5-minute window is enough
  visibility_timeout_seconds = 30
  tags                       = var.tags
}

resource "aws_sqs_queue_policy" "spot_interruptions" {
  queue_url = aws_sqs_queue.spot_interruptions.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.spot_interruptions.arn
    }]
  })
}

# ── EventBridge rule ──────────────────────────────────────────────────────────

resource "aws_cloudwatch_event_rule" "spot_interruption" {
  name        = "burstgrid-spot-interruption"
  description = "EC2 Spot Instance Interruption Warning → SQS"
  event_pattern = jsonencode({
    source      = ["aws.ec2"]
    detail-type = ["EC2 Spot Instance Interruption Warning"]
  })
  tags = var.tags
}

resource "aws_cloudwatch_event_target" "spot_interruption_sqs" {
  rule      = aws_cloudwatch_event_rule.spot_interruption.name
  target_id = "burstgrid-spot-sqs"
  arn       = aws_sqs_queue.spot_interruptions.arn
}

# ── Launch templates (one per fleet tier) ─────────────────────────────────────

resource "aws_launch_template" "fleet" {
  for_each = { for f in var.fleets : f.name => f }

  name_prefix   = "burstgrid-${each.key}-"
  image_id      = var.ami
  instance_type = each.value.instance_type

  iam_instance_profile { arn = aws_iam_instance_profile.worker.arn }
  vpc_security_group_ids = [aws_security_group.worker.id]

  # scheduler_endpoint is baked in by the caller (root module) after the scheduler EIP is known.
  # worker_token is baked in here so each worker can auth with the scheduler on connect.
  user_data = base64encode(templatefile("${path.module}/userdata.sh.tpl", {
    scheduler_url       = var.scheduler_url
    slots_per_worker    = each.value.slots_per_worker
    worker_token        = var.worker_token
    s3_artifacts_bucket = var.s3_artifacts_bucket
    spot_queue_url      = aws_sqs_queue.spot_interruptions.url
    aws_region          = var.aws_region
    firecracker_version = "v1.16.1"
  }))

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  # 30 GiB root: 3 GiB rootfs.img + Node + packages + headroom for 32 concurrent VM sockets
  block_device_mappings {
    device_name = "/dev/sda1"
    ebs {
      volume_size           = 30
      volume_type           = "gp3"
      delete_on_termination = true
    }
  }

  tag_specifications {
    resource_type = "instance"
    tags = merge(var.tags, {
      Name              = "burstgrid-worker-${each.key}"
      "burstgrid:role"  = "runner"
      "burstgrid:fleet" = each.key
    })
  }

  lifecycle { create_before_destroy = true }
}

output "worker_role_arn" { value = aws_iam_role.worker.arn }
output "launch_template_ids" { value = { for k, lt in aws_launch_template.fleet : k => lt.id } }
output "spot_queue_url" { value = aws_sqs_queue.spot_interruptions.url }
output "spot_queue_arn" { value = aws_sqs_queue.spot_interruptions.arn }
