-- Rehearsed safely on a branch database before it ever touches production.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'new';
