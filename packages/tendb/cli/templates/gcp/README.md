# tendb — GCP deployment

Scaffolded by `tendb init`. One Compute Engine host (pd-ssd/ZFS) syncs from
your source Postgres and serves copy-on-write branch databases. The CLI
tunnels over IAP TCP forwarding (`gcloud`) — no public ports.

> GCP support ships syntax/plan-validated but has not been applied to a real
> project yet — expect first-apply issues and please report them.

## Bring it up

1. Create the source secret (never in terraform state):

   ```bash
   printf '%s' 'postgres://user:pass@host:5432/dbname' | \
     gcloud secrets create tendb-source-url --data-file=-
   ```

2. Authenticate terraform: `gcloud auth application-default login`.

3. `tendb up` — wraps `terraform init && terraform apply` here and writes the
   discovery outputs into `tendb.json`.

4. `tendb status`, then `tendb branches create my-feature`.

Client prereqs: Node ≥ 20, `gcloud` (authenticated), and
`roles/iap.tunnelResourceAccessor` — see the `client_iam_snippet` output. The
IAP range (35.235.240.0/20) must stay open to the tunneled ports (the network
module handles this).

Caveats: `postgres_major_version` must match the source; instance replacement
destroys all clones; refreshes are skipped while clones exist.

`tendb down` destroys the stack.
