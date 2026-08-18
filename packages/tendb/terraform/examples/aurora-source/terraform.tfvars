# Pins for the LIVE Aurora stack (deployed pre-rename): renamed defaults
# would replace the cluster and move the publisher-url SSM param.
name              = "tendb-aurora-source"
engine_ssm_prefix = "/tendb"
# Engine host egress: 51.20.21.248 is the console EIP, which moves to the
# engine at cutover. 13.60.76.246 is the old auto-assigned engine IP —
# drop it once replication is verified post-cutover.
client_cidrs = ["13.60.76.246/32", "51.20.21.248/32"]
admin_cidrs  = ["REDACTED/32"]
