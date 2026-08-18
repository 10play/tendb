# AWS platform shim — pf_* functions over SSM Parameter Store / Secrets
# Manager / IMDSv2. Param names are contract leaves; the prefix comes from
# TENDB_PARAM_PREFIX (default /tendb). See terraform/docs/ENGINE-CONTRACT.md.
TENDB_PARAM_PREFIX="${TENDB_PARAM_PREFIX:-/tendb}"
AWS_REGION_ARG=()
[ -n "${TENDB_AWS_REGION:-}" ] && AWS_REGION_ARG=(--region "$TENDB_AWS_REGION")

pf_get_param() {
  aws ssm get-parameter "${AWS_REGION_ARG[@]}" --name "$TENDB_PARAM_PREFIX/$1" \
    --with-decryption --query Parameter.Value --output text 2>/dev/null
}

pf_put_param() {
  aws ssm put-parameter "${AWS_REGION_ARG[@]}" --name "$TENDB_PARAM_PREFIX/$1" \
    --type String --value "$2" --overwrite >/dev/null
}

pf_get_secret() {
  aws secretsmanager get-secret-value "${AWS_REGION_ARG[@]}" \
    --secret-id "$1" --query SecretString --output text
}

pf_self_ip() {
  local imds_token
  imds_token=$(curl -sX PUT "http://169.254.169.254/latest/api/token" \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
  curl -s -H "X-aws-ec2-metadata-token: $imds_token" \
    http://169.254.169.254/latest/meta-data/local-ipv4
}

pf_data_device() {
  # The non-root disk (Nitro renames /dev/sdf to /dev/nvmeXn1).
  local root_disk d
  root_disk=$(lsblk -no PKNAME "$(findmnt -no SOURCE /)" | head -1)
  for d in $(lsblk -dno NAME,TYPE | awk '$2=="disk"{print $1}'); do
    [ "$d" = "$root_disk" ] && continue
    echo "/dev/$d"
    return 0
  done
  return 1
}
