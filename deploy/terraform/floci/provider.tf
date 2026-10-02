terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.0"
    }
  }
  required_version = ">= 1.9"
}

# Points the standard AWS provider at a local Floci instance (github.com/floci-io/floci)
# instead of real AWS, so `terraform apply` here exercises the same reusable
# modules/scheduler and modules/worker-fleet code production uses, without an AWS account.
# Start Floci first: `make dev-aws` (or `docker compose -f ../../../docker-compose.dev.yml up -d floci`).
provider "aws" {
  region = "us-east-1"

  access_key = "test"
  secret_key = "test"

  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
  s3_use_path_style           = true

  endpoints {
    autoscaling = "http://localhost:4566"
    cloudwatch  = "http://localhost:4566"
    dynamodb    = "http://localhost:4566"
    ec2         = "http://localhost:4566"
    elb         = "http://localhost:4566"
    events      = "http://localhost:4566"
    iam         = "http://localhost:4566"
    s3          = "http://localhost:4566"
    sqs         = "http://localhost:4566"
    ssm         = "http://localhost:4566"
    sts         = "http://localhost:4566"
  }
}
