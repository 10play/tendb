# Pins for the LIVE stack (deployed pre-rename). Resource names, the SSM
# prefix, and the AMI are frozen: applying with the renamed defaults would
# recreate the SG/role/params and REPLACE THE ENGINE (= destroy the pool).
# No secrets here — safe to commit. Secret ARNs are suffix-less on purpose
# (the suffixed form changes engine user_data → instance replacement).
name                   = "tendb"
postgres_major_version = 18
source_secret_arn      = "arn:aws:secretsmanager:eu-north-1:409154939891:secret:tendb-smoke/source-url"
sync_target_port       = 5433
engine_ami_id          = "ami-0cda11afd45b74b89"

# Console: served from the engine host (console_on_engine). enable_console
# keeps the old dedicated stack alive until cutover, then flips false.
enable_console        = false
console_on_engine     = true
console_domain        = "console.51-20-21-248.sslip.io"
acme_email            = "amir@10play.dev"
oauth_secret_arn      = "arn:aws:secretsmanager:eu-north-1:409154939891:secret:tendb/console-oauth"
console_instance_type = "t3.medium"
package_tarball_path  = "../../../cli/10play-tendb-0.1.0.tgz"
