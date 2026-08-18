---
title: "Platform: Azure"
description: The tendb engine on an Azure VM — Key Vault params, Bastion tunnels, and the costs and gotchas that come with them.
---

:::danger[Validate-only]
The Azure modules are syntax- and plan-validated (init templates
render-tested, custom_data well under the 64 KB cap) but have **never been
applied to a real subscription**. Expect first-apply friction; read the
module READMEs first.
:::

The Azure platform mirrors the AWS shape under the
[engine contract](/reference/engine-contract/): an Ubuntu 24.04 VM with a
managed data disk for the ZFS pool, Key Vault (RBAC mode) as the param
store, and the Bastion **native-client tunnel** as the transport. VM sizes
by `size`: `Standard_B2s` → `Standard_E2s_v5` → `Standard_E4s_v5` →
`Standard_E8s_v5`.

## Provisioning

The scaffolder is the quickest path — and `tendb up` automates the two-phase
first apply described below (vault first, then the source secret, then the
rest):

```sh
npx @10play/tendb init --platform azure
tendb up
```

Or by hand from a repo clone:

```sh
cd packages/tendb/terraform/examples/azure-standalone
# copy terraform.tfvars.example → terraform.tfvars
terraform init && terraform apply
```

Modules: `modules/azure/engine`, `modules/azure/network` (VNet + engine
subnet + the mandatory `AzureBastionSubnet` /26), `modules/azure/console`.
Contract params are Key Vault secrets with the `/tendb/a/b → tendb-a-b`
[name mapping](/reference/engine-contract/#per-backend-name-mapping);
`instance-id` holds the VM's resource id and the Azure-only `bastion-id`
holds the Bastion host's — the CLI feeds both to
`az network bastion tunnel`.

:::caution[Two-phase first apply]
The source-URL secret lives in the vault this module creates — a
chicken-and-egg on the very first apply: targeted-apply the vault (and the
deployer's Secrets Officer grant), `az keyvault secret set` the source URL,
then run the full apply. The engine README shows the exact commands.
:::

## Client setup

Clients need the **az CLI**, authenticated (`az login`). Roles for a client
principal (the module's `client_role_snippet` output emits the
`az role assignment` commands):

- **Reader** on the VM, the Bastion host, and the VM's NIC (a documented
  Bastion-tunnel requirement)
- **Key Vault Secrets User** on the vault — read-only; operators who
  trigger snapshots or schema syncs write request nonces and need
  **Secrets Officer** instead

Config (the vault name is an apply output — it carries a random suffix
because vault names are global):

```json
{
  "platform": "azure",
  "azureVault": "kv-tendb-a1b2c3",
  "paramPrefix": "/tendb"
}
```

`tendb status` reports `transport bastion`.

## Caveats

- **Bastion costs real money**: native-client tunneling requires the
  **Standard SKU** — roughly **$140/month while idle** — plus a dedicated
  `AzureBastionSubnet` (/26) and a public IP. There is no cheaper native
  tunnel path.
- **Write-only token**: `value_wo` on the Key Vault secret pins
  `azurerm >= 4.23` and `random >= 3.7` (plus Terraform >= 1.11).
- **RBAC propagation**: role assignments propagate asynchronously; the
  engine's boot shim gates on the token becoming readable (up to ~15 min)
  before the init core runs. A first boot that seems slow is usually this.
- **Egress**: Azure retired default outbound access for new subnets; the
  network module's `mode = "nat"` provisions a NAT gateway, and the README
  explains when you need it (a host with no egress hangs in apt at boot).
- **No public ingress at all** — the NSG allows the VNet ranges you list
  plus the Bastion subnet, then denies the rest; admin shell is
  `az network bastion ssh`.
