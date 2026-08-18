# tendb — Azure deployment

Scaffolded by `tendb init`. One Linux VM (managed disk/ZFS) syncs from your
source Postgres and serves copy-on-write branch databases. The CLI tunnels
through a Bastion Standard host (`az network bastion tunnel`).

> Azure support ships syntax/plan-validated but has not been applied to a real
> subscription yet — expect first-apply issues and please report them.
> The Bastion Standard SKU costs ~$140/mo while it exists.

## Bring it up

The source secret lives in the Key Vault this stack creates, so the FIRST
apply is two-phase. `tendb up` automates all of it; manually it is:

```bash
az login   # and export ARM_SUBSCRIPTION_ID unless subscription_id is set

terraform init
terraform apply -target=module.engine.azurerm_key_vault.this \
                -target=module.engine.azurerm_role_assignment.deployer_secrets
printf '%s' 'postgres://user:pass@host:5432/dbname' | \
  az keyvault secret set --vault-name <key_vault_name output> \
    --name tendb-source-url --file /dev/stdin
terraform apply
```

Then: `tendb status`, `tendb branches create my-feature`.

Client prereqs: Node ≥ 20, `az` (logged in), and the role assignments from the
`client_role_snippet` output.

Caveats: `postgres_major_version` must match the source; VM replacement
destroys all clones; refreshes are skipped while clones exist.

`tendb down` destroys the stack (including the Bastion).
