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
