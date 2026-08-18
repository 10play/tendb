# API verification token. Generated ephemerally (GetRandomPassword is purely a
# generator API — nothing is stored in Secrets Manager) and written with a
# write-only argument, so the token never enters Terraform state.
#
# Rotation: bump var.token_secret_version. CAUTION: clone passwords are
# sha256(token:clone) — rotate only when running clones are disposable.
ephemeral "aws_secretsmanager_random_password" "token" {
  password_length     = 32
  exclude_punctuation = true
}

resource "aws_ssm_parameter" "token" {
  name             = "${local.ssm_prefix}/verification-token"
  type             = "SecureString"
  key_id           = var.kms_key_id
  value_wo         = ephemeral.aws_secretsmanager_random_password.token.random_password
  value_wo_version = var.token_secret_version
  tags             = var.tags
}
