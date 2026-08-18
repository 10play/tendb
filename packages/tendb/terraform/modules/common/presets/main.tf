# Platform-neutral t-shirt sizes — the numbers every platform shares (port
# ranges, shm, per-clone postgres configs, disk sizing, dump/restore
# parallelism). Machine types are per-platform and live in each engine
# module's locals. Values mirror modules/aws/engine/locals.tf, which stays
# self-contained until the "engine v2" migration (zero-diff guarantee for the
# live deployment).

variable "size" {
  description = "T-shirt size: small | medium | large | xlarge."
  type        = string
  default     = "small"

  validation {
    condition     = contains(["small", "medium", "large", "xlarge"], var.size)
    error_message = "size must be one of: small, medium, large, xlarge."
  }
}

locals {
  presets = {
    small = {
      root_volume_gb         = 16
      data_volume_gb         = 20
      data_volume_iops       = null
      data_volume_throughput = null
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
    xlarge = {
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
        maintenance_work_mem = "2GB"
      }
    }
  }

  preset = local.presets[var.size]
}
