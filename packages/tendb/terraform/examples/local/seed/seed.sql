-- Demo data so branches have something worth branching.
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

INSERT INTO users (email)
SELECT 'user' || n || '@example.com' FROM generate_series(1, 500) n;

INSERT INTO orders (user_id, total)
SELECT (random() * 499 + 1)::int, round((random() * 500)::numeric, 2)
FROM generate_series(1, 5000);
