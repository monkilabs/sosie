CREATE TYPE role AS ENUM ('admin', 'editor', 'viewer');
CREATE TYPE order_status AS ENUM ('new', 'paid', 'shipped', 'cancelled');

CREATE TABLE countries (code char(2) PRIMARY KEY, name text NOT NULL);

CREATE TABLE users (
  id          serial PRIMARY KEY,
  email       varchar(120) UNIQUE,
  full_name   text NOT NULL,
  phone       text,
  city        text,
  api_key     text,
  account     text,
  active      boolean NOT NULL DEFAULT true,
  role        role NOT NULL,
  created_at  timestamptz NOT NULL,
  born_on     date,
  profile     jsonb,
  tags        text[],
  last_ip     inet,
  avatar      bytea,
  score       numeric(8, 2),
  external_id uuid,
  country     char(2) REFERENCES countries (code)
);

CREATE TABLE orders (
  id        bigserial PRIMARY KEY,
  user_id   int NOT NULL REFERENCES users (id),
  status    order_status NOT NULL,
  total     numeric(10, 2) NOT NULL,
  note      text,
  placed_at timestamp NOT NULL
);

CREATE TABLE events (id int PRIMARY KEY, user_id int REFERENCES users (id), kind text NOT NULL);

CREATE VIEW active_users AS SELECT id, email, full_name FROM users WHERE active;

CREATE SCHEMA billing;
CREATE TABLE billing.invoices (id int PRIMARY KEY, order_id bigint REFERENCES orders (id), amount numeric(10, 2));

CREATE FUNCTION user_email(uid int) RETURNS text LANGUAGE sql STABLE AS $$ SELECT email FROM users WHERE id = uid $$;

INSERT INTO countries VALUES ('CZ', 'Czechia'), ('SK', 'Slovakia'), ('AT', 'Austria');

INSERT INTO users (email, full_name, phone, city, api_key, account, active, role, created_at, born_on, profile, tags, last_ip, avatar, score, external_id, country) VALUES
  ('quill.vantablack@canary-mail.test', 'Quillon Vantablack', '+420 777 912 345', 'Vantaville', 'sk_live_9Qv7Xc2Lm8Rt', '7739182046',
   true, 'admin', '2025-03-14 09:26:53.589+01', '1988-02-29',
   '{"email": "quill.vantablack@canary-mail.test", "nickname": "Quillon", "visits": 42, "vip": true, "address": {"city": "Vantaville"}}',
   '{vip,"Quillon Vantablack",NULL}', '10.20.30.40', '\xdeadbeef', 1234.56, 'd3adb33f-0000-4000-8000-c0ffee000001', 'CZ'),
  ('zephyrine@orrowmoor.test', 'Zephyrine Orrowmoor', '+421 905 111 222', 'Orrowmoor', 'sk_live_Zz8yYx7wWv6u', '5512093377',
   false, 'editor', '2024-11-02 18:00:00+00', '1979-06-15',
   '{"email": "zephyrine@orrowmoor.test", "nickname": "Zephy", "visits": 7, "vip": false, "address": {"city": "Orrowmoor"}}',
   '{early}', '10.20.30.41', '\x00ff', 99.90, 'd3adb33f-0000-4000-8000-c0ffee000002', 'SK');

INSERT INTO users (email, full_name, phone, city, api_key, active, role, created_at, born_on, country)
SELECT 'person' || g || '@example.org', 'Person ' || g, '+1 555 0100 ' || g, 'Springfield', 'key_' || g, g % 2 = 0,
       (ARRAY['admin', 'editor', 'viewer'])[1 + g % 3]::role, '2025-01-01'::timestamptz + g * interval '1 day', '1990-01-01'::date + g, 'AT'
FROM generate_series(3, 40) g;

INSERT INTO orders (user_id, status, total, note, placed_at) VALUES
  (1, 'paid', 120.50, 'leave the parcel with Quillon', '2025-04-01 10:00:00'),
  (1, 'new', 9.99, 'ring twice', '2025-04-02 11:30:00'),
  (2, 'shipped', 1500.00, NULL, '2025-04-03 12:00:00'),
  (3, 'paid', 42.00, 'gift', '2025-04-04 13:15:00'),
  (3, 'cancelled', 7.00, NULL, '2025-04-05 14:45:00');

INSERT INTO events SELECT g, 1 + g % 40, 'click' FROM generate_series(1, 150) g;

INSERT INTO billing.invoices VALUES (1, 1, 120.50), (2, 3, 1500.00);
