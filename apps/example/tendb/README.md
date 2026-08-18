# tendb — local deployment

Scaffolded by `tendb init`. Runs DBLab + snapshotd as Docker containers on a
ZFS-capable host — your laptop, no cloud account. Without a `source_url` it
also runs a seeded demo Postgres to branch from.

## Bring it up

```bash
tendb up
```

`up` first runs `scripts/host-setup.sh` (idempotent): on macOS it installs and
starts a colima VM (Docker Desktop won't work — no ZFS in its kernel), builds
a file-backed zpool, then runs `terraform apply` against the VM's docker
socket and writes the discovery outputs into `tendb.json`.

After the first sync (~1 min for the demo source):

```bash
tendb status
tendb branches create my-feature
tendb psql my-feature
tendb console          # Neon-style dashboard on localhost
```

Knobs: `TENDB_VM_CPUS/MEMORY/DISK`, `TENDB_POOL_SIZE`, `TENDB_COLIMA_PROFILE`
(preflight); `source_url`, `size`, `postgres_major_version` (terraform.tfvars).

`tendb down` destroys the containers; the colima VM stays (`colima delete` to
reclaim it).
