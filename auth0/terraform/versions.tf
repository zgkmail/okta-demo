terraform {
  required_version = ">= 1.5"

  required_providers {
    auth0 = {
      source  = "auth0/auth0"
      version = "~> 1.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

# Credentials come from the environment, never from a file:
#   AUTH0_CLIENT_ID / AUTH0_CLIENT_SECRET  (the M2M bootstrap app -- see README)
provider "auth0" {
  domain = var.auth0_tenant_domain
}
