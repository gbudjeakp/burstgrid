variable "vpc_id"              { type = string }
variable "subnet_id"           { type = string }
variable "ami"                 { type = string }
variable "instance_type"       { type = string }
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
variable "burstgrid_fleets"    { type = string }   # JSON — rendered in root module
variable "s3_artifacts_bucket" { type = string }
variable "spot_queue_url"      { type = string }
variable "worker_iam_role_arn" { type = string }
variable "aws_region"          { type = string }
variable "tags" {
  type    = map(string)
  default = {}
}

# ── Security group ────────────────────────────────────────────────────────────

resource "aws_security_group" "scheduler" {
  name_prefix = "burstgrid-scheduler-"
  vpc_id      = var.vpc_id
  description = "BurstGrid scheduler"

  ingress {
    description = "GitHub webhooks + worker SSE long-poll"
    from_port   = 8080
    to_port     = 8080
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, { Name = "burstgrid-scheduler" })
}

# ── IAM role + policies ───────────────────────────────────────────────────────

resource "aws_iam_role" "scheduler" {
  name_prefix = "burstgrid-scheduler-"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
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
        Sid      = "LaunchWorkers"
        Effect   = "Allow"
        Action   = [
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
        Sid      = "S3Artifacts"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:ListBucket"]
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

# ── Elastic IP ────────────────────────────────────────────────────────────────
# Stable public address for the GitHub webhook URL.
# Persists across instance replacements — just reassociate after terraform apply.

resource "aws_eip" "scheduler" {
  domain = "vpc"
  tags   = merge(var.tags, { Name = "burstgrid-scheduler" })
}

resource "aws_eip_association" "scheduler" {
  instance_id   = aws_instance.scheduler.id
  allocation_id = aws_eip.scheduler.id
}

# ── EC2 instance ──────────────────────────────────────────────────────────────

resource "aws_instance" "scheduler" {
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

  user_data = base64encode(templatefile("${path.module}/userdata.sh.tpl", {
    webhook_secret      = var.webhook_secret
    worker_token        = var.worker_token
    github_token        = var.github_token
    github_app_id       = var.github_app_id
    burstgrid_fleets    = var.burstgrid_fleets
    s3_artifacts_bucket = var.s3_artifacts_bucket
    spot_queue_url      = var.spot_queue_url
    aws_region          = var.aws_region
  }))

  tags = merge(var.tags, { Name = "burstgrid-scheduler", "burstgrid:role" = "scheduler" })

  lifecycle {
    # Replacing the instance and re-associating the EIP is safer than in-place updates
    create_before_destroy = true
  }
}

output "public_ip"         { value = aws_eip.scheduler.public_ip }
output "private_ip"        { value = aws_instance.scheduler.private_ip }
output "instance_id"       { value = aws_instance.scheduler.id }
