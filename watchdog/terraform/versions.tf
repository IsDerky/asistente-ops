terraform {
  required_version = ">= 1.6"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }

  # Estado local y fuera de git: guarda los secretos de los bindings en claro.
}

provider "cloudflare" {
  # Token con permisos de Workers Scripts y Workers KV: CLOUDFLARE_API_TOKEN
}
