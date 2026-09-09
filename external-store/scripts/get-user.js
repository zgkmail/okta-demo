/**
 * Auth0 Custom Database — Get User script.
 *
 * Answers "does this identifier exist?" without a password. Auth0 calls it for
 * things like the Identifier First screen and password-reset flows.
 *
 * The important detail is the not-found case: call back with NO arguments.
 * Calling back with an error would report an outage, and Auth0 would surface a
 * server error where it should simply say the account does not exist.
 */
function getByEmail(email, callback) {
  const { Client } = require('pg');

  const client = new Client({
    connectionString: configuration.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  client.connect((connectErr) => {
    if (connectErr) return callback(connectErr);

    client.query(
      'select id, email from users where email = $1',
      [email],
      (queryErr, result) => {
        client.end();
        if (queryErr) return callback(queryErr);

        // Not found is not an error.
        if (result.rows.length === 0) return callback(null);

        const user = result.rows[0];
        return callback(null, {
          user_id: user.id,
          email: user.email,
          email_verified: true,
        });
      }
    );
  });
}
