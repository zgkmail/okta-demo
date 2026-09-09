/**
 * Auth0 Custom Database — Login script.
 *
 * Runs on Auth0's servers, not here, which is why the database has to be
 * reachable from the internet. It is called on every authentication against
 * this connection: with "Import Users to Auth0" disabled there is no local copy
 * to fall back on, so this function IS the authentication.
 *
 * `configuration.DATABASE_URL` comes from the connection's configuration map,
 * set by Terraform from a variable that is never committed.
 */
function login(email, password, callback) {
  const bcrypt = require('bcrypt');
  const { Client } = require('pg');

  const client = new Client({
    connectionString: configuration.DATABASE_URL,
    // Neon terminates TLS at its proxy. Verifying the chain properly is the
    // right thing for production; this is a demo shortcut and is called out in
    // the README rather than left silent.
    ssl: { rejectUnauthorized: false },
  });

  client.connect((connectErr) => {
    if (connectErr) return callback(connectErr);

    client.query(
      'select id, email, password_hash from users where email = $1',
      [email],
      (queryErr, result) => {
        if (queryErr) {
          client.end();
          return callback(queryErr);
        }

        if (result.rows.length === 0) {
          client.end();
          // WrongUsernameOrPasswordError rather than a generic error: it tells
          // Auth0 this was a credential failure, not an outage, so the user
          // sees "wrong email or password" instead of a server error.
          return callback(new WrongUsernameOrPasswordError(email));
        }

        const user = result.rows[0];

        bcrypt.compare(password, user.password_hash, (compareErr, isValid) => {
          client.end();
          if (compareErr) return callback(compareErr);
          if (!isValid) return callback(new WrongUsernameOrPasswordError(email));

          // The profile Auth0 will use. user_id becomes the `sub` claim,
          // prefixed here so it is visibly not an Auth0-issued identifier.
          return callback(null, {
            user_id: user.id,
            email: user.email,
            email_verified: true,
          });
        });
      }
    );
  });
}
