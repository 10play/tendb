data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "this" {
  name               = var.name
  assume_role_policy = data.aws_iam_policy_document.assume.json
  tags               = var.tags
}

# Session Manager (no SSH anywhere).
resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.this.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# The HOST pulls the source URL + its own token at boot — credentials never
# transit user-data, CI, or Terraform values.
data "aws_iam_policy_document" "boot" {
  statement {
    sid     = "SourceUrlFromSecret"
    actions = ["secretsmanager:GetSecretValue"]
    # Trailing * tolerates name-form ARNs missing the random 6-char suffix.
    resources = ["${var.source_secret_arn}*"]
  }

  statement {
    sid       = "DiscoveryParams"
    actions   = ["ssm:GetParameter"]
    resources = ["arn:aws:ssm:${local.region}:${local.account_id}:parameter${local.ssm_prefix}/*"]
  }

  statement {
    sid       = "PublishDbName"
    actions   = ["ssm:PutParameter"]
    resources = [aws_ssm_parameter.dbname.arn]
  }
}

resource "aws_iam_role_policy" "boot" {
  name   = "${var.name}-boot"
  role   = aws_iam_role.this.id
  policy = data.aws_iam_policy_document.boot.json
}

resource "aws_iam_instance_profile" "this" {
  name = var.name
  role = aws_iam_role.this.name
  tags = var.tags
}

# ---------------------------------------------------------------------------
# Ready-made policy for CLI/CI principals (attach to your CI role or operator
# group). Tag-conditioned instance access survives instance replacement.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "client" {
  statement {
    sid     = "SsmDocuments"
    actions = ["ssm:SendCommand", "ssm:StartSession"]
    resources = [
      "arn:aws:ssm:${local.region}::document/AWS-RunShellScript",
      "arn:aws:ssm:${local.region}::document/AWS-StartPortForwardingSession",
    ]
  }

  statement {
    sid       = "SsmInstanceByTag"
    actions   = ["ssm:SendCommand", "ssm:StartSession"]
    resources = ["arn:aws:ec2:${local.region}:${local.account_id}:instance/*"]
    condition {
      test     = "StringEquals"
      variable = "ssm:resourceTag/Role"
      values   = [local.ssm_access_tag_value]
    }
  }

  statement {
    sid       = "SsmSessionHousekeeping"
    actions   = ["ssm:GetCommandInvocation", "ssm:TerminateSession"]
    resources = ["*"]
  }

  # Discovery + token: the CLI derives clone passwords locally, so it must
  # read the SecureString token (default aws/ssm key needs no kms grant).
  statement {
    sid       = "DiscoveryParams"
    actions   = ["ssm:GetParameter"]
    resources = ["arn:aws:ssm:${local.region}:${local.account_id}:parameter${local.ssm_prefix}/*"]
  }
}

resource "aws_iam_policy" "client" {
  count  = var.create_client_iam_policy ? 1 : 0
  name   = "${var.name}-client"
  policy = data.aws_iam_policy_document.client.json
  tags   = var.tags
}
