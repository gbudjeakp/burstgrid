variable "vpc_id" { type = string }
variable "subnet_id" { type = string }
variable "ami" { type = string }
variable "instance_type" { type = string }
variable "webhook_secret" {
  type      = string
  sensitive = true
}
variable "worker_token" {
  type      = string
  sensitive = true
}
variable "github_token" {
  type      = string
  sensitive = true
  default   = ""
}
variable "github_app_id" {
  type    = number
  default = 0
}
variable "secret_source" { type = string }
variable "webhook_secret_ssm_parameter" { type = string }
variable "worker_token_ssm_parameter" { type = string }
variable "github_token_ssm_parameter" { type = string }
variable "github_app_key_ssm_parameter" { type = string }
variable "otel_collector_enabled" { type = bool }
variable "otel_collector_version" { type = string }
variable "otel_env_ssm_parameter" { type = string }
variable "burstgrid_fleets" { type = string } # JSON — rendered in root module
variable "s3_artifacts_bucket" { type = string }
variable "spot_queue_url" { type = string }
variable "worker_iam_role_arn" { type = string }
variable "aws_region" { type = string }
variable "tags" {
  type    = map(string)
  default = {}
}

# Self-healing availability: an ALB (stable DNS name) in front of a desired=1 ASG,
# instead of a single EC2 instance with a directly-associated EIP. Default off —
# identical behavior to the original single-instance design when left false.
variable "ha_enabled" {
  type    = bool
  default = false
}

# Public subnets (>=2 AZs) for the ALB. Only required/used when ha_enabled = true.
variable "subnet_ids" {
  type    = list(string)
  default = []
}

# ── Security group ────────────────────────────────────────────────────────────

resource "aws_security_group" "scheduler" {
  name_prefix = "burstgrid-scheduler-"
  vpc_id      = var.vpc_id
  description = "BurstGrid scheduler"

  # Non-HA: webhook + SSE traffic hits the instance directly.
  dynamic "ingress" {
    for_each = var.ha_enabled ? [] : [1]
    content {
      description = "GitHub webhooks + worker SSE long-poll"
      from_port   = 8080
      to_port     = 8080
      protocol    = "tcp"
      cidr_blocks = ["0.0.0.0/0"]
    }
  }

  # HA: only the ALB may reach the instance; public traffic terminates at the ALB.
  dynamic "ingress" {
    for_each = var.ha_enabled ? [1] : []
    content {
      description     = "ALB health checks + forwarded traffic"
      from_port       = 8080
      to_port         = 8080
      protocol        = "tcp"
      security_groups = [aws_security_group.alb[0].id]
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, { Name = "burstgrid-scheduler" })
}

# Internet-facing ALB — stable DNS name survives instance replacement, unlike the
# EIP-per-instance model which needs a manual reassociate step today.
resource "aws_security_group" "alb" {
  count       = var.ha_enabled ? 1 : 0
  name_prefix = "burstgrid-scheduler-alb-"
  vpc_id      = var.vpc_id
  description = "BurstGrid scheduler ALB — public HTTP ingress"

  ingress {
    description = "GitHub webhooks + worker traffic"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, { Name = "burstgrid-scheduler-alb" })
}

# ── IAM role + policies ───────────────────────────────────────────────────────

resource "aws_iam_role" "scheduler" {
  name_prefix = "burstgrid-scheduler-"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Action = "sts:AssumeRole", Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" } }]
  })
  tags = var.tags
}

resource "aws_iam_role_policy" "scheduler" {
  name = "burstgrid-scheduler"
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ReadBurstGridSecrets"
        Effect = "Allow"
        Action = ["ssm:GetParameter"]
        Resource = [
          "arn:aws:ssm:${var.aws_region}:*:parameter${var.webhook_secret_ssm_parameter}",
          "arn:aws:ssm:${var.aws_region}:*:parameter${var.worker_token_ssm_parameter}",
          "arn:aws:ssm:${var.aws_region}:*:parameter${var.github_token_ssm_parameter}",
          "arn:aws:ssm:${var.aws_region}:*:parameter${var.github_app_key_ssm_parameter}",
          "arn:aws:ssm:${var.aws_region}:*:parameter${var.otel_env_ssm_parameter}",
        ]
      },
      {
        Sid    = "LaunchWorkers"
        Effect = "Allow"
        Action = [
          "ec2:RunInstances",
          "ec2:TerminateInstances",
          "ec2:DescribeInstances",
          "ec2:DescribeInstanceStatus",
          "ec2:CreateTags",
        ]
        Resource = "*"
      },
      {
        Sid      = "PassWorkerRole"
        Effect   = "Allow"
        Action   = "iam:PassRole"
        Resource = var.worker_iam_role_arn
      },
      {
        # Scheduler polls this queue for spot interruption warnings forwarded by workers
        Sid      = "SpotQueue"
        Effect   = "Allow"
        Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
        Resource = "*"
      },
      {
        Sid    = "S3Artifacts"
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:ListBucket"]
        Resource = [
          "arn:aws:s3:::${var.s3_artifacts_bucket}",
          "arn:aws:s3:::${var.s3_artifacts_bucket}/*",
        ]
      },
    ]
  })
}

# SSM allows shell access without SSH keys — no key pair needed on the instance
resource "aws_iam_role_policy_attachment" "scheduler_ssm" {
  role       = aws_iam_role.scheduler.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "scheduler" {
  name_prefix = "burstgrid-scheduler-"
  role        = aws_iam_role.scheduler.name
}

locals {
  scheduler_userdata = templatefile("${path.module}/userdata.sh.tpl", {
    webhook_secret               = var.webhook_secret
    worker_token                 = var.worker_token
    github_token                 = var.github_token
    github_app_id                = var.github_app_id
    secret_source                = var.secret_source
    webhook_secret_ssm_parameter = var.webhook_secret_ssm_parameter
    worker_token_ssm_parameter   = var.worker_token_ssm_parameter
    github_token_ssm_parameter   = var.github_token_ssm_parameter
    github_app_key_ssm_parameter = var.github_app_key_ssm_parameter
    otel_collector_enabled       = var.otel_collector_enabled
    otel_collector_version       = var.otel_collector_version
    otel_env_ssm_parameter       = var.otel_env_ssm_parameter
    burstgrid_fleets             = var.burstgrid_fleets
    s3_artifacts_bucket          = var.s3_artifacts_bucket
    spot_queue_url               = var.spot_queue_url
    aws_region                   = var.aws_region
  })
}

# ── Elastic IP (non-HA only) ──────────────────────────────────────────────────
# Stable public address for the GitHub webhook URL.
# Persists across instance replacements — just reassociate after terraform apply.
# In HA mode the ALB's DNS name is the stable address instead; see below.

resource "aws_eip" "scheduler" {
  count  = var.ha_enabled ? 0 : 1
  domain = "vpc"
  tags   = merge(var.tags, { Name = "burstgrid-scheduler" })
}

resource "aws_eip_association" "scheduler" {
  count         = var.ha_enabled ? 0 : 1
  instance_id   = aws_instance.scheduler[0].id
  allocation_id = aws_eip.scheduler[0].id
}

# ── EC2 instance (non-HA only) ────────────────────────────────────────────────

resource "aws_instance" "scheduler" {
  count                  = var.ha_enabled ? 0 : 1
  ami                    = var.ami
  instance_type          = var.instance_type
  subnet_id              = var.subnet_id
  vpc_security_group_ids = [aws_security_group.scheduler.id]
  iam_instance_profile   = aws_iam_instance_profile.scheduler.name

  # IMDSv2 required
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  user_data = base64encode(local.scheduler_userdata)

  tags = merge(var.tags, { Name = "burstgrid-scheduler", "burstgrid:role" = "scheduler" })

  lifecycle {
    # Replacing the instance and re-associating the EIP is safer than in-place updates
    create_before_destroy = true
    precondition {
      condition     = var.secret_source != "terraform" || (var.webhook_secret != "" && var.worker_token != "")
      error_message = "webhook_secret and worker_token must be set when secret_source=terraform."
    }
  }
}

# ── HA mode: ALB + self-healing ASG (desired=1) ───────────────────────────────
# Replaces the single EC2 instance + EIP with a stable ALB endpoint and an ASG
# that automatically relaunches the scheduler on an EC2 status-check or ALB
# health-check failure — no manual terraform apply or EIP reassociation needed.
# Rolling redeploys of a new launch template version still require a manual ASG
# instance refresh; this covers failure recovery, not zero-downtime deploys.

resource "aws_lb" "scheduler" {
  count              = var.ha_enabled ? 1 : 0
  name_prefix        = "bgsch-"
  internal           = false
  load_balancer_type = "application"
  subnets            = var.subnet_ids
  security_groups    = [aws_security_group.alb[0].id]

  tags = merge(var.tags, { Name = "burstgrid-scheduler-alb" })
}

resource "aws_lb_target_group" "scheduler" {
  count       = var.ha_enabled ? 1 : 0
  name_prefix = "bgsch-"
  port        = 8080
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "instance"

  health_check {
    path                = "/health/ready"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = merge(var.tags, { Name = "burstgrid-scheduler" })
}

resource "aws_lb_listener" "scheduler" {
  count             = var.ha_enabled ? 1 : 0
  load_balancer_arn = aws_lb.scheduler[0].arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.scheduler[0].arn
  }
}

resource "aws_launch_template" "scheduler" {
  count         = var.ha_enabled ? 1 : 0
  name_prefix   = "burstgrid-scheduler-"
  image_id      = var.ami
  instance_type = var.instance_type

  iam_instance_profile {
    arn = aws_iam_instance_profile.scheduler.arn
  }

  network_interfaces {
    associate_public_ip_address = true
    security_groups             = [aws_security_group.scheduler.id]
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  user_data = base64encode(local.scheduler_userdata)

  tag_specifications {
    resource_type = "instance"
    tags          = merge(var.tags, { Name = "burstgrid-scheduler", "burstgrid:role" = "scheduler" })
  }

  lifecycle {
    create_before_destroy = true
    precondition {
      condition     = var.secret_source != "terraform" || (var.webhook_secret != "" && var.worker_token != "")
      error_message = "webhook_secret and worker_token must be set when secret_source=terraform."
    }
  }
}

resource "aws_autoscaling_group" "scheduler" {
  count               = var.ha_enabled ? 1 : 0
  name_prefix         = "burstgrid-scheduler-"
  vpc_zone_identifier = var.subnet_ids
  desired_capacity    = 1
  min_size            = 1
  max_size            = 1
  target_group_arns   = [aws_lb_target_group.scheduler[0].arn]

  # ELB health check means an ALB-reported unhealthy target gets replaced too,
  # not just an EC2-level status check failure. Grace period covers apt-get +
  # Node.js install + S3 downloads on first boot.
  health_check_type         = "ELB"
  health_check_grace_period = 180

  launch_template {
    id      = aws_launch_template.scheduler[0].id
    version = "$Latest"
  }

  tag {
    key                 = "Name"
    value               = "burstgrid-scheduler"
    propagate_at_launch = true
  }
  tag {
    key                 = "burstgrid:role"
    value               = "scheduler"
    propagate_at_launch = true
  }

  lifecycle {
    create_before_destroy = true
  }
}

output "public_ip" { value = var.ha_enabled ? null : aws_eip.scheduler[0].public_ip }
output "private_ip" { value = var.ha_enabled ? null : aws_instance.scheduler[0].private_ip }
output "instance_id" { value = var.ha_enabled ? null : aws_instance.scheduler[0].id }

output "scheduler_url" {
  description = "Base URL workers and the GitHub webhook should use — ALB DNS name in HA mode, EIP otherwise."
  value       = var.ha_enabled ? "http://${aws_lb.scheduler[0].dns_name}" : "http://${aws_eip.scheduler[0].public_ip}:8080"
}
