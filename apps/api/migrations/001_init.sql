CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE books (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  author text NOT NULL DEFAULT '',
  format text NOT NULL CHECK (format IN ('pdf','epub')),
  file_path text NOT NULL,
  cover_path text,
  file_size bigint NOT NULL,
  total_pages int,
  added_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON books(user_id, added_at DESC);

CREATE TABLE reading_progress (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id uuid NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  position jsonb NOT NULL,
  percent numeric(5,2) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, book_id)
);

CREATE TABLE annotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id uuid NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('highlight','note')),
  position jsonb NOT NULL,
  quoted_text text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '',
  color text NOT NULL DEFAULT 'yellow',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON annotations(book_id, created_at);