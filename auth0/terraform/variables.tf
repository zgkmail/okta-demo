variable "auth0_tenant_domain" {
  description = <<-EOT
    The tenant domain, NOT the custom domain. The Management API that this
    provider talks to lives at the tenant domain; the custom domain serves end
    users. Mixing them up produces confusing 401s.
  EOT
  type        = string
  default     = "dev-brceciohbwk3emhb.us.auth0.com"
}

variable "auth0_issuer_base_url" {
  description = <<-EOT
    The custom domain, used by the applications at runtime. Passkeys bind to the
    RP ID derived from this host, so this must be the custom domain and not the
    tenant domain.
  EOT
  type        = string
  default     = "https://auth.littlecap.biz"
}

# Real hostnames rather than localhost, mapped to 127.0.0.1 via /etc/hosts.
#
# Auth0 treats localhost and custom URI schemes as non-verifiable callbacks and
# shows a confirmation screen even for first-party applications, to prevent one
# local app impersonating another on a shared device. is_first_party does not
# suppress it. Using an ordinary domain makes the callback verifiable, so the
# consent screen disappears.
#
# Requires in /etc/hosts:
#   127.0.0.1  baseline.littlecap.biz sensitive.littlecap.biz

variable "baseline_base_url" {
  description = "Origin the Baseline App is served from."
  type        = string
  default     = "http://baseline.littlecap.biz:3000"
}

variable "sensitive_base_url" {
  description = "Origin the Sensitive App is served from."
  type        = string
  default     = "http://sensitive.littlecap.biz:3001"
}

variable "external_db_url" {
  description = <<-EOT
    Postgres connection string for the external user store (Bonus B). Auth0 runs
    the custom database scripts on its own servers, so this must be reachable
    from the internet -- a local Postgres will not work without a tunnel.

    Supply it from the environment and never commit it:
      export TF_VAR_external_db_url='postgresql://...neon.tech/...?sslmode=require'
  EOT
  type        = string
  sensitive   = true
  default     = ""
}

variable "mobile_login_hint" {
  description = <<-EOT
    Optional email to prefill the native app's identifier screen, purely to save
    typing on a simulator. Empty by default so no address is committed to a
    public repository -- set it in a gitignored .tfvars if you want it.
  EOT
  type        = string
  default     = ""
}

variable "step_up_ttl_seconds" {
  description = <<-EOT
    How long a completed step-up stays valid in the Sensitive App. Drop it to
    something small (30) to exercise the re-challenge path without waiting.
  EOT
  type        = number
  default     = 300
}
