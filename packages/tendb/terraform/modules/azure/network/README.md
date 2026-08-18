# tendb network module — azure

One VNet (`10.60.0.0/16` by default) with two subnets:

| subnet | prefix (default cidr) | purpose |
|---|---|---|
| `AzureBastionSubnet` | `10.60.0.0/26` | Bastion. The name is mandated by Azure **verbatim**; /26 is the documented minimum. |
| `<name>-engine` | `10.60.1.0/24` | Engine host (and console, in the standalone example). |

## Egress (`mode`)

- `default` — relies on Azure's **default outbound access**. Free, but Azure
  retired it for subnets created after **2025-09-30**: on newer subscriptions
  the engine may come up with no internet path at all, and init will hang on
  apt/Docker pulls (`/var/log/dblab-init.log` shows the apt retry loop
  spinning). Switch to `mode = "nat"` if that happens.
- `nat` — a NAT gateway on the engine subnet: ~$32/mo plus $0.045/GB
  processed. Note the nightly logical dump rides this — a 100 GB dump is
  ≈ $135/mo of processing on top of the base price.

The engine has no public IP in either mode; inbound stays Bastion-only.
