-- Modo typing (escritorio): progreso reanudable y puntuaciones por libro.
CREATE TABLE typing_progress (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id uuid NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  word_index int NOT NULL DEFAULT 0 CHECK (word_index >= 0),
  char_index int NOT NULL DEFAULT 0 CHECK (char_index >= 0),
  keyboard_layout text NOT NULL DEFAULT 'qwerty-es',
  target_lang text NOT NULL DEFAULT 'en',
  bilingual boolean NOT NULL DEFAULT false,
  total_words int NOT NULL DEFAULT 0 CHECK (total_words >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, book_id)
);

CREATE TABLE typing_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id uuid NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  wpm numeric(6,2) NOT NULL DEFAULT 0,
  accuracy numeric(5,2) NOT NULL DEFAULT 0,
  score int NOT NULL DEFAULT 0,
  words_completed int NOT NULL DEFAULT 0,
  errors int NOT NULL DEFAULT 0,
  duration_ms int NOT NULL DEFAULT 0,
  keyboard_layout text NOT NULL DEFAULT 'qwerty-es',
  target_lang text NOT NULL DEFAULT 'en',
  bilingual boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON typing_scores(user_id, book_id, created_at DESC);
