# tendb engine module — azure

The DBLab host on Azure: one Linux VM (Ubuntu 24.04 + ZFS on a managed disk)
running `dblab-server` in Docker, syncing from a source Postgres by logical
dump/restore, serving thin-clone branch databases on a port pool. Satisfies
the engine contract (`terraform/docs/ENGINE-CONTRACT.md`); the AWS module is
the reference implementation.

> **Status: validate-only.** This module passes `terraform validate` but has
> not yet been applied against a live subscription.

```hcl
module "engine" {
  source = "…/tendb/terraform/modules/azure/engine"

  name                = "tendb"
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  subnet_id           = module.network.engine_subnet_id
  bastion_subnet_id   = module.network.bastion_subnet_id
  bastion_subnet_cidr = module.network.bastion_subnet_cidr
  client_cidrs        = [module.network.cidr] # in-VNet clients; the CLI tunnels via Bastion regardless

  admin_ssh_public_key = file("~/.ssh/id_ed25519.pub") # azurerm requires one; no public SSH path exists

  size                   = "medium" # small | medium | large | xlarge (+ per-knob overrides)
  postgres_major_version = 18       # MUST match the source — no default
  source_secret_name     = "tendb-source-url"
}
```

## Bastion: the tunnel transport (and the bill)

- The CLI reaches the API/UI/clone ports through
  `az network bastion tunnel`, targeting the VM's resource id (published as
  the `instance-id` param). That needs a **Standard-SKU Bastion with
  `tunneling_enabled`** — which this module creates by default.
- **Cost: a Standard Bastion idles at roughly $140/month** (~$0.19/h, before
  data transfer) — by far the platform's biggest fixed cost, and it accrues
  while completely idle. One Bastion serves a whole VNet: point
  `create_bastion = false` + `bastion_host_id` at an existing one to share.
- Bastion lives in a subnet named **exactly `AzureBastionSubnet`**, minimum
  **/26** — the azure network module creates it.
- Clients need the **az CLI** (`brew install azure-cli`; `az login`) — the
  tendb CLI shells out to it for both Key Vault reads and tunnels. Grant the
  roles from the `client_role_snippet` output.

## Design points

- **No public ingress.** The NIC has no public IP; the NSG admits only
  `client_cidrs` and the Bastion subnet, then denies the rest (overriding
  Azure's default allow-VNet rule). Admin access is `az network bastion ssh`
  with the key from `admin_ssh_public_key` — azurerm refuses key-less Linux
  VMs, which is the only reason a key exists at all.
- **Key Vault is the param store.** Contract names map `/tendb/a/b` →
  `tendb-a-b`. The vault is created in RBAC mode (or bring one via
  `key_vault_id`); the VM's managed identity gets Secrets Officer — Key Vault
  RBAC has no per-secret-name scoping, so that is the tightest possible
  grant.
- **Secrets never touch state or custom_data.** The host pulls the source URL
  and its token at boot via its managed identity. The token is generated
  ephemerally and written with a write-only argument (`value_wo`,
  azurerm >= 4.23, terraform >= 1.11).
- **Discovery params** under `param_prefix` (default `/<name>`):
  `instance-id`, `host`, `verification-token`, `dbname` (host-published at
  boot), `port-pool`, and the azure-only `bastion-id`. They die with the
  module — a missing `instance-id` is the "platform is down" signal.
- **CLI config**: point tendb at the vault with the `azureVault` field in
  `tendb.json` (or `TENDB_AZURE_VAULT`) — see the azure-standalone example's
  `cli_discovery` output.

## Bootstrap order (source secret)

The source URL lives in the same vault this module creates, so a first-ever
apply is two-phase:

```sh
terraform apply -target=module.engine.azurerm_key_vault.this \
                -target=module.engine.azurerm_role_assignment.deployer_secrets
az keyvault secret set --vault-name <vault> --name tendb-source-url \
  --value 'postgres://user:pass@host:5432/dbname'
terraform apply
```

Bringing your own vault (`key_vault_id`) with the secret already in it makes
it a single apply.

## Gotchas

- **RBAC propagation race**: the VM's vault role is assigned after the VM
  exists and propagates asynchronously. The boot shim gates on a successful
  token read (up to ~15 min) and the data-disk attach is sequenced after the
  grant, but if first boot still loses the race, init fails visibly in
  `/var/log/dblab-init.log`; recover with `terraform apply`
  `-replace=module.engine.azurerm_linux_virtual_machine.this` (cloud-init
  runs custom_data once per instance — a reboot does not retry).
- **custom_data is immutable**: any init change replaces the VM and destroys
  the ZFS pool with every clone on it. Grep plans for "must be replaced".
- **xlarge = PremiumV2 disk**: provisioned IOPS/throughput per the shared
  presets; most regions require pinning `zone` for PremiumV2.
- Vault soft-delete (7 days, no purge protection): destroy then re-apply works
  because the vault name carries a random suffix; purge manually
  (`az keyvault purge`) only if you must reclaim the exact name.
