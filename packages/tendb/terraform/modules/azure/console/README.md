# tendb console module — azure

Hosts the same server `tendb console` runs locally, next to the engine
(direct in-VNet TCP), behind Google login and automatic HTTPS. Mirror of
`modules/aws/console`.

```
browser → :443 Caddy → :4180 oauth2-proxy (Google) → :4400 tendb console
```

> **Status: validate-only** — same as the azure engine module.

## Prerequisites

1. A Google OAuth client (created by hand in the Google Cloud console) stored
   in the **engine's Key Vault** as JSON:
   `az keyvault secret set --vault-name <vault> --name <oauth_secret_name> --file client.json`
   with `{"client_id": "...", "client_secret": "..."}`.
2. A domain. Either pass `dns_zone_name` (Azure DNS) or create the A record
   from the `required_dns_record` output yourself.
3. The package: a packed CLI tarball (`package_tarball_path` → private blob,
   MSI-token download, ETag-polling in-place updater) XOR a published
   `npm_package_spec`.

## Azure specifics

- Boot-time secret/param reads use the embedded platform shim
  (`snapshotd/shims/azure.sh` — Key Vault REST with the VM's managed
  identity). No account keys: the package blob is fetched with a Bearer token
  for `https://storage.azure.com/`.
- The **az CLI is installed and logged in as the managed identity** anyway:
  the console's Node process writes runtime params (snapshot schedule, alert
  webhook, schema config) through the tendb azure adapter, which shells out
  to `az keyvault`.
- The console identity gets **Key Vault Secrets Officer** on the engine
  vault — Key Vault RBAC cannot scope writes to the `snapshots/*`/`alerts/*`/
  `schema/*` subtrees the way the AWS module's IAM policy does.
- Reaching the engine: the engine NSG admits `client_cidrs` — include the
  VNet CIDR (as the azure-standalone example does) so the console's direct
  TCP to 2345 works.
