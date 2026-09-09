-- Bonus B — the user store that Auth0 does not own.
--
-- Run this once in the Neon SQL editor. It needs no local tooling: pgcrypto
-- does the bcrypt hashing in the database, so there is nothing to install and
-- no plaintext password ever leaves this file.
--
-- The point of the exercise is what is NOT here: these rows never enter Auth0's
-- user store. The connection runs with "Import Users to Auth0" disabled, so
-- Auth0 delegates every authentication back to this table and keeps no copy.

create extension if not exists pgcrypto;

create table if not exists users (
  id            text primary key,
  email         text unique not null,
  password_hash text not null,
  created_at    timestamptz not null default now()
);

-- Two demo users. gen_salt('bf') produces a $2a$ bcrypt hash, which is what
-- bcrypt.compare in the Login script expects.
insert into users (id, email, password_hash) values
  ('ext|alice', 'alice@littlecap.biz', crypt('ExternalDemo2026!', gen_salt('bf'))),
  ('ext|bob',   'bob@littlecap.biz',   crypt('ExternalDemo2026!', gen_salt('bf')))
on conflict (email) do nothing;

-- Deliberate: the id prefix makes it obvious in a token's `sub` claim that this
-- user came from here rather than from Auth0's own store.
select id, email, left(password_hash, 7) as hash_prefix, created_at from users;
