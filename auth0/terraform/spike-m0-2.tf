/**
 * SPIKE M0.2 — THROWAWAY. Delete this file once the question is answered.
 *
 * Question: can passkeys be enabled on a custom database connection with user
 * import DISABLED? That decides whether Bonus B is one connection or two
 * (DESIGN.md §5).
 *
 *   - Applies cleanly  → users live only in Postgres AND passkeys work.
 *                        Bonus B is a single connection. Rung 1.
 *   - Rejected         → drop to the §5 fallback ladder: a separate Auth0-store
 *                        connection for passkeys alongside a delegated one.
 *
 * Deliberately attached to NO client, so whatever happens here cannot affect
 * the working Baseline/Sensitive setup.
 *
 * The scripts are stubs returning a hardcoded user. Real Postgres is not needed
 * to find out whether Auth0 permits the configuration, and building it before
 * knowing the answer would be wasted work.
 */

resource "auth0_connection" "spike_custom_db" {
  name     = "spike-m0-2-custom-db"
  strategy = "auth0"

  options {
    # "Use my own database", with lazy migration OFF -- the combination Auth0's
    # older guidance says is incompatible with passkeys.
    enabled_database_customization = true
    import_mode                    = false

    # Passkeys require usernames disabled (or flexible identifiers enabled).
    requires_username = false
    disable_signup    = false

    # Carries the `context` object into the scripts, which the no-import passkey
    # path needs so Get User can distinguish an identifier lookup from a user_id
    # lookup.
    strategy_version = 2

    custom_scripts = {
      login = <<-EOF
        function login(email, password, callback) {
          return callback(null, {
            user_id: 'spike-user-1',
            email: email,
            email_verified: true
          });
        }
      EOF

      # The EA requirement: handle BOTH lookup by identifier (context.identifierType
      # unset) and lookup by user_id (context.identifierType === 'user_id').
      get_user = <<-EOF
        function getByEmail(email, callback, context) {
          if (context && context.identifierType === 'user_id') {
            return callback(null, {
              user_id: email,
              email: 'spike@example.com',
              email_verified: true
            });
          }
          return callback(null, {
            user_id: 'spike-user-1',
            email: email,
            email_verified: true
          });
        }
      EOF

      # Must return a profile containing user_id.
      create = <<-EOF
        function create(user, callback) {
          return callback(null, { user_id: 'spike-user-1' });
        }
      EOF
    }

    # The actual question. If Auth0 rejects this combination, the apply fails
    # here and we have our answer.
    authentication_methods {
      passkey {
        enabled = true
      }
      password {
        enabled = true
      }
    }
  }
}

output "spike_m0_2_result" {
  description = "If this renders, Auth0 accepted passkeys on a no-import custom DB."
  value       = "PASSKEYS ACCEPTED on ${auth0_connection.spike_custom_db.name} (import_mode=false)"
}
