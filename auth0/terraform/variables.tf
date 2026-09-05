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

variable "baseline_base_url" {
  description = "Origin the Baseline App is served from."
  type        = string
  default     = "http://localhost:3000"
}

variable "sensitive_base_url" {
  description = "Origin the Sensitive App is served from."
  type        = string
  default     = "http://localhost:3001"
}
