# tendb console module (gcp)

Hosted `tendb console` on a small VM next to the engine: Caddy (:80/:443,
automatic HTTPS) → oauth2-proxy (:4180, Google login restricted to
`allowed_email_domains`) → the console on loopback. GCP mirror of
`modules/aws/console` — same stack, with the pf_* Secret Manager shim in
place of the AWS CLI and a GCS object (md5Hash-polled by the on-host
updater) in place of the S3 tarball.

**Status: validate-only** (never applied; the AWS module is the reference).

Prereqs, created out of band:

- a Google OAuth client stored in Secret Manager as
  `{"client_id": "...", "client_secret": "..."}` (`oauth_secret_id`), with
  the `oauth_redirect_uri` output authorized on it;
- a domain — either a Cloud DNS `managed_zone` for the A record, or create
  the `required_dns_record` output yourself;
- the engine module applied first: the console's per-secret IAM binds to
  secrets the engine creates (`engine_param_prefix` = its `param_prefix`
  output), and its VM must be able to reach 2345 + clone ports — include the
  subnet CIDR in the engine's `client_cidr_ranges`.
