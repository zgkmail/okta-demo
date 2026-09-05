locals {
  # http://localhost:3000 -> "3000". Falls back if a URL without a port is used.
  ports = {
    baseline  = try(element(split(":", var.baseline_base_url), 2), "3000")
    sensitive = try(element(split(":", var.sensitive_base_url), 2), "3001")
  }
}

output "baseline_client_id" {
  description = "Not secret -- safe to paste into a chat or an issue."
  value       = auth0_client.app["baseline"].client_id
}

output "sensitive_client_id" {
  description = "Not secret -- safe to paste into a chat or an issue."
  value       = auth0_client.app["sensitive"].client_id
}

# Render each app's .env so nothing has to be copied by hand:
#
#   terraform output -raw baseline_env  > ../../apps/baseline/.env
#   terraform output -raw sensitive_env > ../../apps/sensitive/.env
#
# Both are marked sensitive, so `terraform output` alone will not print them.

output "baseline_env" {
  description = "Full .env contents for the Baseline App."
  sensitive   = true
  value       = <<-EOT
    AUTH0_ISSUER_BASE_URL=${var.auth0_issuer_base_url}
    AUTH0_CLIENT_ID=${auth0_client.app["baseline"].client_id}
    AUTH0_CLIENT_SECRET=${auth0_client_credentials.app["baseline"].client_secret}
    BASE_URL=${var.baseline_base_url}
    PORT=${local.ports.baseline}
    PEER_URL=${var.sensitive_base_url}
    SESSION_SECRET=${random_id.session_secret["baseline"].hex}
  EOT
}

output "sensitive_env" {
  description = "Full .env contents for the Sensitive App."
  sensitive   = true
  value       = <<-EOT
    AUTH0_ISSUER_BASE_URL=${var.auth0_issuer_base_url}
    AUTH0_CLIENT_ID=${auth0_client.app["sensitive"].client_id}
    AUTH0_CLIENT_SECRET=${auth0_client_credentials.app["sensitive"].client_secret}
    BASE_URL=${var.sensitive_base_url}
    PORT=${local.ports.sensitive}
    PEER_URL=${var.baseline_base_url}
    SESSION_SECRET=${random_id.session_secret["sensitive"].hex}
  EOT
}
