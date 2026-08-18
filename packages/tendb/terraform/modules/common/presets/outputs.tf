output "root_volume_gb" {
  value = local.preset.root_volume_gb
}

output "data_volume_gb" {
  value = local.preset.data_volume_gb
}

output "data_volume_iops" {
  value = local.preset.data_volume_iops
}

output "data_volume_throughput" {
  value = local.preset.data_volume_throughput
}

output "port_from" {
  value = local.preset.port_from
}

output "port_to" {
  value = local.preset.port_to
}

output "shm_size" {
  value = local.preset.shm_size
}

output "dump_parallel_jobs" {
  value = local.preset.dump_parallel_jobs
}

output "restore_parallel_jobs" {
  value = local.preset.restore_parallel_jobs
}

output "postgres_configs" {
  description = "Per-clone Postgres settings; pg_stat_statements is merged in by consumers."
  value       = local.preset.postgres_configs
}
