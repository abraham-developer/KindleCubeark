ALTER TABLE books ADD COLUMN visibility text NOT NULL DEFAULT 'personal' CHECK (visibility IN ('personal','global'));
CREATE INDEX ON books(visibility, added_at DESC);
