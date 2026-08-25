variable "vpc_id" { type = string }
variable "subnet_ids" { type = list(string) }
variable "scheduler_endpoint" { type = string }
variable "ami" { type = string }
variable "instance_type" { type = string; default = "c7i.4xlarge" }
variable "slots_per_worker" { type = number; default = 16 }
variable "tags" { type = map(string); default = {} }

resource "aws_security_group" "worker" {
  name_prefix = "burstgrid-worker-"
  vpc_id      = var.vpc_id
  description = "BurstGrid worker — egress only"

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, { Name = "burstgrid-worker" })
}

resource "aws_iam_role" "worker" {
  name_prefix = "burstgrid-worker-"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Action = "sts:AssumeRole", Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" } }]
  })
  tags = var.tags
}

# SSM for ops access; no SSH required on worker nodes
resource "aws_iam_role_policy_attachment" "worker_ssm" {
  role       = aws_iam_role.worker.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "worker" {
  name_prefix = "burstgrid-worker-"
  role        = aws_iam_role.worker.name
}

resource "aws_launch_template" "worker" {
  name_prefix   = "burstgrid-worker-"
  image_id      = var.ami
  instance_type = var.instance_type

  iam_instance_profile { arn = aws_iam_instance_profile.worker.arn }
  vpc_security_group_ids = [aws_security_group.worker.id]

  user_data = base64encode(templatefile("${path.module}/userdata.sh.tpl", {
    scheduler_endpoint = var.scheduler_endpoint
    slots_per_worker   = var.slots_per_worker
  }))

  # IMDSv2 required — the worker agent uses it to resolve its instance-id
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  tag_specifications {
    resource_type = "instance"
    tags = merge(var.tags, { Name = "burstgrid-worker", "burstgrid:role" = "worker" })
  }
}

output "worker_role_arn" { value = aws_iam_role.worker.arn }
output "launch_template_id" { value = aws_launch_template.worker.id }
