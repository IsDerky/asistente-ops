output "kv_namespace_id" {
  description = "ID del KV donde el Worker guarda las señales"
  value       = cloudflare_workers_kv_namespace.state.id
}

output "worker_name" {
  value = cloudflare_workers_script.watchdog.script_name
}
