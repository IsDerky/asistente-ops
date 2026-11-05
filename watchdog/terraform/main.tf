locals {
  # El Worker se compila antes con: bun build src/index.ts --outfile dist/worker.js --target browser --format esm
  worker_file = "${path.module}/../dist/worker.js"
}

resource "cloudflare_workers_kv_namespace" "state" {
  account_id = var.account_id
  title      = "${var.worker_name}-state"
}

resource "cloudflare_workers_script" "watchdog" {
  account_id         = var.account_id
  script_name        = var.worker_name
  main_module        = "worker.js"
  content_file       = local.worker_file
  content_sha256     = filesha256(local.worker_file)
  compatibility_date = "2026-10-01"

  bindings = [
    {
      type         = "kv_namespace"
      name         = "STATE"
      namespace_id = cloudflare_workers_kv_namespace.state.id
    },
    {
      type = "secret_text"
      name = "PING_TOKEN"
      text = var.ping_token
    },
    {
      type = "secret_text"
      name = "DISCORD_BOT_TOKEN"
      text = var.discord_bot_token
    },
    {
      type = "plain_text"
      name = "DISCORD_USER_ID"
      text = var.discord_user_id
    },
  ]

  observability = {
    enabled = true
  }
}

resource "cloudflare_workers_cron_trigger" "sweep" {
  account_id  = var.account_id
  script_name = cloudflare_workers_script.watchdog.script_name
  schedules = [
    { cron = var.cron },
  ]
}

# URL pública en <worker>.<subdominio>.workers.dev, a la que llama ops-ping
resource "cloudflare_workers_script_subdomain" "watchdog" {
  account_id  = var.account_id
  script_name = cloudflare_workers_script.watchdog.script_name
  enabled     = true
}
