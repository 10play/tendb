-- Demo data so branches have something worth branching. Timestamps are
-- spread over the trailing weeks so the data reads as lived-in, not seeded.
CREATE TABLE users (
  id         serial PRIMARY KEY,
  email      text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id         serial PRIMARY KEY,
  user_id    int NOT NULL REFERENCES users (id),
  total      numeric(10, 2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO users (email, created_at)
SELECT 'user' || n || '@example.com', now() - (random() * interval '90 days')
FROM generate_series(1, 500) n;

INSERT INTO orders (user_id, total, created_at)
SELECT (random() * 499 + 1)::int, round((random() * 500)::numeric, 2),
       now() - (random() * interval '60 days')
FROM generate_series(1, 5000);
