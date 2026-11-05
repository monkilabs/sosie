CREATE TABLE countries (code CHAR(2) PRIMARY KEY, name VARCHAR(60) NOT NULL);

CREATE TABLE users (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  email       VARCHAR(120) UNIQUE,
  full_name   VARCHAR(200) NOT NULL,
  phone       VARCHAR(40),
  city        VARCHAR(80),
  api_key     VARCHAR(60),
  account     VARCHAR(20),
  active      TINYINT(1) NOT NULL DEFAULT 1,
  role        ENUM('admin', 'editor', 'viewer') NOT NULL,
  created_at  DATETIME(3) NOT NULL,
  born_on     DATE,
  profile     JSON,
  avatar      VARBINARY(16),
  score       DECIMAL(8, 2),
  external_id CHAR(36),
  country     CHAR(2),
  FOREIGN KEY (country) REFERENCES countries (code)
);

CREATE TABLE orders (
  id        BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id   INT NOT NULL,
  status    ENUM('new', 'paid', 'shipped', 'cancelled') NOT NULL,
  total     DECIMAL(10, 2) NOT NULL,
  note      TEXT,
  placed_at DATETIME NOT NULL,
  -- A flag as Hibernate maps a boolean, and bits.
  gift      BIT(1) NOT NULL DEFAULT b'0',
  marks     BIT(12),
  FOREIGN KEY (user_id) REFERENCES users (id)
);

CREATE VIEW active_users AS SELECT id, email, full_name FROM users WHERE active;

INSERT INTO countries VALUES ('CZ', 'Czechia'), ('SK', 'Slovakia'), ('AT', 'Austria');

INSERT INTO users (email, full_name, phone, city, api_key, account, active, role, created_at, born_on, profile, avatar, score, external_id, country) VALUES
  ('quill.vantablack@canary-mail.test', 'Quillon Vantablack', '+420 777 912 345', 'Vantaville', 'sk_live_9Qv7Xc2Lm8Rt', '7739182046',
   1, 'admin', '2025-03-14 09:26:53.589', '1988-02-29',
   '{"email": "quill.vantablack@canary-mail.test", "nickname": "Quillon", "visits": 42, "vip": true, "address": {"city": "Vantaville"}}',
   x'deadbeef', 1234.56, 'd3adb33f-0000-4000-8000-c0ffee000001', 'CZ'),
  ('zephyrine@orrowmoor.test', 'Zephyrine Orrowmoor', '+421 905 111 222', 'Orrowmoor', 'sk_live_Zz8yYx7wWv6u', '5512093377',
   0, 'editor', '2024-11-02 18:00:00', '1979-06-15',
   '{"email": "zephyrine@orrowmoor.test", "nickname": "Zephy", "visits": 7, "vip": false, "address": {"city": "Orrowmoor"}}',
   x'00ff', 99.90, 'd3adb33f-0000-4000-8000-c0ffee000002', 'SK');

INSERT INTO users (email, full_name, phone, city, api_key, active, role, created_at, born_on, country)
SELECT CONCAT('person', n, '@example.org'), CONCAT('Person ', n), CONCAT('+1 555 0100 ', n), 'Springfield', CONCAT('key_', n), n % 2 = 0,
       ELT(1 + n % 3, 'admin', 'editor', 'viewer'), '2025-01-01' + INTERVAL n DAY, '1990-01-01' + INTERVAL n DAY, 'AT'
FROM (WITH RECURSIVE g (n) AS (SELECT 3 UNION ALL SELECT n + 1 FROM g WHERE n < 40) SELECT n FROM g) AS numbers;

INSERT INTO orders (user_id, status, total, note, placed_at) VALUES
  (1, 'paid', 120.50, 'leave the parcel with Quillon', '2025-04-01 10:00:00'),
  (1, 'new', 9.99, 'ring twice', '2025-04-02 11:30:00'),
  (2, 'shipped', 1500.00, NULL, '2025-04-03 12:00:00'),
  (3, 'paid', 42.00, 'gift', '2025-04-04 13:15:00'),
  (3, 'cancelled', 7.00, NULL, '2025-04-05 14:45:00');
UPDATE orders SET gift = b'1', marks = b'101100111010' WHERE id IN (1, 4);
