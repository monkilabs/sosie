CREATE TABLE countries (code CHAR(2) PRIMARY KEY, name NVARCHAR(60) NOT NULL);

CREATE TABLE users (
  id          INT IDENTITY PRIMARY KEY,
  email       NVARCHAR(120) UNIQUE,
  full_name   NVARCHAR(200) NOT NULL,
  phone       VARCHAR(40),
  city        NVARCHAR(80),
  api_key     VARCHAR(60),
  account     VARCHAR(20),
  active      BIT NOT NULL DEFAULT 1,
  created_at  DATETIME2(3) NOT NULL,
  born_on     DATE,
  avatar      VARBINARY(16),
  score       DECIMAL(8, 2),
  external_id UNIQUEIDENTIFIER,
  country     CHAR(2) REFERENCES countries (code)
);

CREATE TABLE orders (
  id        BIGINT IDENTITY PRIMARY KEY,
  user_id   INT NOT NULL REFERENCES users (id),
  status    VARCHAR(20) NOT NULL,
  total     DECIMAL(10, 2) NOT NULL,
  note      NVARCHAR(MAX),
  placed_at DATETIME NOT NULL,
  gift      BIT NOT NULL DEFAULT 0
);
GO

CREATE SCHEMA billing;
GO

CREATE TABLE billing.invoices (number VARCHAR(20) PRIMARY KEY, order_id BIGINT NOT NULL REFERENCES orders (id), amount MONEY NOT NULL, issued_at DATETIMEOFFSET(0) NOT NULL);

-- One column of every type SQL Server has, a value in each.
CREATE TABLE kinds (
  id INT PRIMARY KEY,
  t TINYINT, s SMALLINT, b BIGINT, f FLOAT, r REAL, m MONEY, sm SMALLMONEY, n NUMERIC(20, 5),
  d DATE, tm TIME(3), dt DATETIME, sdt SMALLDATETIME, dt2 DATETIME2(7), dto DATETIMEOFFSET(7),
  c CHAR(5), nc NCHAR(5), vc VARCHAR(MAX), nvc NVARCHAR(MAX), tx TEXT, ntx NTEXT,
  bn BINARY(4), vb VARBINARY(MAX), img IMAGE, x XML, g GEOGRAPHY, h HIERARCHYID, v SQL_VARIANT
);
GO

CREATE VIEW active_users AS SELECT id, email, full_name FROM users WHERE active = 1;
GO

INSERT INTO countries VALUES ('CZ', N'Czechia'), ('SK', N'Slovakia'), ('AT', N'Austria');

INSERT INTO users (email, full_name, phone, city, api_key, account, active, created_at, born_on, avatar, score, external_id, country) VALUES
  (N'quill.vantablack@canary-mail.test', N'Quillon Vantablack', '+420 777 912 345', N'Vantaville', 'sk_live_9Qv7Xc2Lm8Rt', '7739182046',
   1, '2025-03-14 09:26:53.589', '1988-02-29', 0xdeadbeef, 1234.56, 'd3adb33f-0000-4000-8000-c0ffee000001', 'CZ'),
  (N'zephyrine@orrowmoor.test', N'Zephyrine Orrowmoor', '+421 905 111 222', N'Orrowmoor', 'sk_live_Zz8yYx7wWv6u', '5512093377',
   0, '2024-11-02 18:00:00', '1979-06-15', 0x00ff, 99.90, 'd3adb33f-0000-4000-8000-c0ffee000002', 'SK');

WITH g (n) AS (SELECT 3 UNION ALL SELECT n + 1 FROM g WHERE n < 40)
INSERT INTO users (email, full_name, phone, city, api_key, active, created_at, born_on, country)
SELECT CONCAT('person', n, '@example.org'), CONCAT('Person ', n), CONCAT('+1 555 0100 ', n), 'Springfield', CONCAT('key_', n), n % 2,
       DATEADD(DAY, n, '2025-01-01'), DATEADD(DAY, n, '1990-01-01'), 'AT'
FROM g;

INSERT INTO orders (user_id, status, total, note, placed_at, gift) VALUES
  (1, 'paid', 120.50, N'leave the parcel with Quillon', '2025-04-01 10:00:00', 1),
  (1, 'new', 9.99, N'ring twice', '2025-04-02 11:30:00', 0),
  (2, 'shipped', 1500.00, NULL, '2025-04-03 12:00:00', 0),
  (3, 'paid', 42.00, N'gift', '2025-04-04 13:15:00', 1),
  (3, 'cancelled', 7.00, NULL, '2025-04-05 14:45:00', 0);

INSERT INTO billing.invoices VALUES ('INV-1', 1, 120.50, '2025-04-01 10:00:00 +02:00'), ('INV-2', 3, 1500.00, '2025-04-03 12:00:00 -05:00');

INSERT INTO kinds VALUES (
  1, 200, -12345, 9007199254740993, 3.14159265358979, 2.5, 922337203685.4775, 214748.3647, 123456789012345.12345,
  '2024-02-29', '23:59:59.997', '2025-03-14 09:26:53.590', '2025-03-14 09:27:00', '2025-03-14 09:26:53.5891234', '2025-03-14 09:26:53.5891234 +05:30',
  'Quill', N'Zeph', REPLICATE(CAST('quill ' AS VARCHAR(MAX)), 2000), N'Žluťoučký kůň Quillon', 'old text', N'old ntext',
  0x01020304, 0xdeadbeef, 0xcafe, N'<user email="quill.vantablack@canary-mail.test">Quillon</user>',
  geography::Point(50.08, 14.42, 4326), hierarchyid::Parse('/1/2/'), CAST(42 AS SQL_VARIANT)
);
