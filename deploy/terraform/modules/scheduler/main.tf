variable "vpc_id" { type = string }
variable "subnet_id" { type = string }
variable "ami" { type = string }
variable "instance_type" { type = string }
variable "webhook_secret" { type = string; sensitive = true }
variable "github_app_id" { type = number }
variable "worker_iam_role_arn" { type = string }
variable "tags" { type = map(string); default = {} }

resource "aws_security_group" "scheduler" {
  name_prefix = "burstgrid-scheduler-"
  vpc_id      = var.vpc_id
  description = "BurstGrid scheduler"

  ingress {
    description = "GitHub webhooks + worker long-poll"
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

resource "aws_iam_role" "scheduler" {
  name_prefix = "burstgrid-scheduler-"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Action = "sts:AssumeRole", Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" } }]
  })
  tags = var.tags
}

resource "aws_iam_role_policy" "scheduler_ec2" {
  name = "burstgrid-scheduler-ec2"
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "LaunchWorkers"
        Effect = "Allow"
        Action = ["ec2:RunInstances", "ec2:TerminateInstances", "ec2:DescribeInstances", "ec2:CreateTags"]
        Resource = "*"
      },
      {
        Sid      = "PassWorkerRole"
        Effect   = "Allow"
        Action   = "iam:PassRole"
        Resource = var.worker_iam_role_arn
      }
    ]
  })
}

resource "aws_iam_instance_profile" "scheduler" {
  name_prefix = "burstgrid-scheduler-"
  role        = aws_iam_role.scheduler.name
}

resource "aws_instance" "scheduler" {
  ami                    = var.ami
  instance_type          = var.instance_type
  subnet_id              = var.subnet_id
  vpc_security_group_ids = [aws_security_group.scheduler.id]
  iam_instance_profile   = aws_iam_instance_profile.scheduler.name

  user_data = base64encode(templatefile("${path.module}/userdata.sh.tpl", {
    webhook_secret = var.webhook_secret
    github_app_id  = var.github_app_id
  }))

  tags = merge(var.tags, { Name = "burstgrid-scheduler", "burstgrid:role" = "scheduler" })
}

output "internal_endpoint" { value = "http://${aws_instance.scheduler.private_ip}:8080" }
output "public_ip" { value = aws_instance.scheduler.public_ip }
