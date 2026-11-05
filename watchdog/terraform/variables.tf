variable "account_id" {
  description = "ID de la cuenta de Cloudflare"
  type        = string
}

variable "worker_name" {
  description = "Nombre del Worker (y de su URL en workers.dev)"
  type        = string
  default     = "ops-watchdog"
}

variable "ping_token" {
  description = "Token Bearer que el servidor manda en cada señal"
  type        = string
  sensitive   = true
}

variable "discord_bot_token" {
  description = "Token del bot de Discord que manda los avisos"
  type        = string
  sensitive   = true
}

variable "discord_user_id" {
  description = "ID de Discord de quien recibe los avisos"
  type        = string
}

variable "cron" {
  description = "Cada cuánto revisa las señales"
  type        = string
  default     = "*/5 * * * *"
}
