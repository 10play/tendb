locals {
  # T-shirt sizes. Per-clone shared_buffers stays deliberately small at every
  # size: clones share the host page cache / ZFS ARC, and N concurrent clones
  # each allocate shared_buffers — scaling it with RAM would overcommit at
  # full port-pool width.
  size_presets = {
    small = {
      instance_type          = "t3.medium" # 4 GB
      root_volume_gb         = 16
      data_volume_gb         = 20
      data_volume_iops       = null # gp3 baseline (3000)
      data_volume_throughput = null # gp3 baseline (125 MB/s)
      port_from              = 6000
      port_to                = 6009 # 10 clones
      shm_size               = "512mb"
      dump_parallel_jobs     = 1
      restore_parallel_jobs  = 1
      postgres_configs = {
        shared_buffers       = "256MB"
        work_mem             = "32MB"
        maintenance_work_mem = "128MB"
      }
    }
    medium = {
      instance_type          = "r6i.large" # 16 GB
      root_volume_gb         = 20
      data_volume_gb         = 100
      data_volume_iops       = null
      data_volume_throughput = null
      port_from              = 6000
      port_to                = 6019 # 20 clones
      shm_size               = "1g"
      dump_parallel_jobs     = 2
      restore_parallel_jobs  = 2
      postgres_configs = {
        shared_buffers       = "512MB"
        work_mem             = "64MB"
        maintenance_work_mem = "256MB"
      }
    }
    large = {
      instance_type          = "r6i.xlarge" # 32 GB
      root_volume_gb         = 20
      data_volume_gb         = 200
      data_volume_iops       = null
      data_volume_throughput = null
      port_from              = 6000
      port_to                = 6039 # 40 clones
      shm_size               = "2g"
      dump_parallel_jobs     = 4
      restore_parallel_jobs  = 4
      postgres_configs = {
        shared_buffers       = "1GB"
        work_mem             = "64MB"
        maintenance_work_mem = "512MB"
      }
    }
    # Sized for a 200 GB–1 TB source. Pool rule of thumb: dump + restored data
    # + clone CoW deltas ≈ 2.5× source (lz4 helps, don't bank on it). At 1 TB
    # the gp3 baselines would make restore crawl — throughput/IOPS are
    # provisioned here, and restore parallelism matches the 8 vCPUs.
    xlarge = {
      instance_type          = "r6i.2xlarge" # 64 GB
      root_volume_gb         = 20
      data_volume_gb         = 2500
      data_volume_iops       = 12000
      data_volume_throughput = 750 # MB/s
      port_from              = 6000
      port_to                = 6049 # 50 clones
      shm_size               = "4g"
      dump_parallel_jobs     = 8
      restore_parallel_jobs  = 8
      postgres_configs = {
        shared_buffers       = "1GB"
        work_mem             = "128MB"
        maintenance_work_mem = "2GB" # index builds during restore
      }
    }
  }

  preset = local.size_presets[var.size]

  instance_type         = coalesce(var.instance_type, local.preset.instance_type)
  root_volume_gb        = coalesce(var.root_volume_gb, local.preset.root_volume_gb)
  data_volume_gb        = coalesce(var.data_volume_gb, local.preset.data_volume_gb)
  shm_size              = coalesce(var.shm_size, local.preset.shm_size)
  dump_parallel_jobs    = coalesce(var.dump_parallel_jobs, local.preset.dump_parallel_jobs)
  restore_parallel_jobs = coalesce(var.restore_parallel_jobs, local.preset.restore_parallel_jobs)

  # These may be null all the way through (gp3 baseline), so no coalesce.
  data_volume_iops       = var.data_volume_iops != null ? var.data_volume_iops : local.preset.data_volume_iops
  data_volume_throughput = var.data_volume_throughput != null ? var.data_volume_throughput : local.preset.data_volume_throughput

  port_from = var.clone_port_range != null ? var.clone_port_range.from : local.preset.port_from
  port_to   = var.clone_port_range != null ? var.clone_port_range.to : local.preset.port_to

  # Overrides win; pg_stat_statements ships in every size.
  postgres_configs = merge(
    local.preset.postgres_configs,
    { shared_preload_libraries = "pg_stat_statements" },
    var.postgres_configs,
  )

  ssm_prefix           = coalesce(var.ssm_prefix, "/${var.name}")
  ssm_access_tag_value = coalesce(var.ssm_access_tag_value, var.name)
  clone_image          = coalesce(var.clone_image, "postgresai/extended-postgres:${var.postgres_major_version}-0.8.0")

  region     = data.aws_region.current.region
  account_id = data.aws_caller_identity.current.account_id
}

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
