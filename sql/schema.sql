-- =====================================================================
-- MJPremium Ultimate MLM System - PostgreSQL schema
-- Direct port of the WordPress plugin tables (wp_mlm_*).
-- Timezone: Asia/Manila (UTC+8) is applied at the application layer and
-- with a DB session default below, exactly like the PHP plugin does with
-- `SET time_zone = '+08:00'`.
-- =====================================================================

-- Idempotent: safe to run on every deploy (see scripts/db-push.mjs).

CREATE TABLE IF NOT EXISTS users (
  id                              BIGSERIAL PRIMARY KEY,
  username                        VARCHAR(100) NOT NULL UNIQUE,
  password_hash                   TEXT NOT NULL,
  email                           VARCHAR(190) NOT NULL DEFAULT '',
  display_name                    VARCHAR(190) NOT NULL DEFAULT '',
  first_name                      VARCHAR(100) NOT NULL DEFAULT '',
  middle_name                     VARCHAR(100) NOT NULL DEFAULT '',
  last_name                       VARCHAR(100) NOT NULL DEFAULT '',
  phone                           VARCHAR(50)  NOT NULL DEFAULT '',
  bday                            VARCHAR(30)  NOT NULL DEFAULT '',
  gender                          VARCHAR(20)  NOT NULL DEFAULT '',
  civil                           VARCHAR(30)  NOT NULL DEFAULT '',
  address                         TEXT         NOT NULL DEFAULT '',
  profile_picture                 TEXT         NOT NULL DEFAULT '',
  -- mlm_rank in the plugin. Starter / Premium / StarPremium (+ Free label)
  rank                            VARCHAR(100) NOT NULL DEFAULT 'Premium',
  achievement_rank                VARCHAR(100) NOT NULL DEFAULT 'Member',
  -- pending | active
  activation_status               VARCHAR(20)  NOT NULL DEFAULT 'pending',
  is_admin                        BOOLEAN      NOT NULL DEFAULT FALSE,
  sponsor_id                      BIGINT       NOT NULL DEFAULT 0,
  member_id_number                VARCHAR(60)  NOT NULL DEFAULT '',
  member_id_expires               DATE,
  -- Unilevel monthly LP counter (per-month or lifetime depending on settings)
  monthly_lp                      INTEGER      NOT NULL DEFAULT 0,
  monthly_lp_period               VARCHAR(7)   NOT NULL DEFAULT '',
  -- Lifetime product LP (used product codes)
  lp                              INTEGER      NOT NULL DEFAULT 0,
  -- Lifetime Direct Referral bonuses paid to this member
  lifetime_dr_paid                NUMERIC(18,2) NOT NULL DEFAULT 0,
  wallet_balance                  NUMERIC(18,2) NOT NULL DEFAULT 0,
  hang_balance                    NUMERIC(18,2) NOT NULL DEFAULT 0,
  account_held                    BOOLEAN      NOT NULL DEFAULT FALSE,
  -- Free account options (structure is identical; these affect EARNINGS only)
  is_free_account                 BOOLEAN      NOT NULL DEFAULT FALSE,
  free_account_kind               VARCHAR(4)   NOT NULL DEFAULT '',   -- MA | CA
  free_display_rank               VARCHAR(100) NOT NULL DEFAULT '',
  free_receive_pairing            BOOLEAN      NOT NULL DEFAULT FALSE,
  free_count_for_upline_pairing   BOOLEAN      NOT NULL DEFAULT FALSE,
  free_pay_direct_referral        BOOLEAN      NOT NULL DEFAULT FALSE,
  rank_history                    JSONB        NOT NULL DEFAULT '[]'::jsonb,
  created_at                      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_sponsor  ON users (sponsor_id);
CREATE INDEX IF NOT EXISTS idx_users_rank     ON users (rank);
CREATE INDEX IF NOT EXISTS idx_users_created  ON users (created_at);

-- ---------------------------------------------------------------------
-- Genealogy / placement accounts (wp_mlm_accounts)
-- position: L = A leg, C = B leg, R = C leg
-- account_type: MA = Mother Account, CA = Child Account
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT      NOT NULL,
  sponsor_id      BIGINT      NOT NULL DEFAULT 0,
  upline_id       BIGINT      NOT NULL DEFAULT 0,
  position        VARCHAR(1)  NOT NULL DEFAULT 'L' CHECK (position IN ('L','C','R')),
  account_type    VARCHAR(2)  NOT NULL DEFAULT 'MA' CHECK (account_type IN ('MA','CA')),
  pairing_count   INTEGER     NOT NULL DEFAULT 0,
  left_points     INTEGER     NOT NULL DEFAULT 0,
  center_points   INTEGER     NOT NULL DEFAULT 0,
  right_points    INTEGER     NOT NULL DEFAULT 0,
  depth           INTEGER     NOT NULL DEFAULT 0,
  rank_snapshot   VARCHAR(100),
  activated_at    TIMESTAMPTZ,
  status          SMALLINT    NOT NULL DEFAULT 0,
  -- Event time for chronological earnings replay (batch rebuild step 3)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_accounts_created ON accounts (created_at);

CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_slot      ON accounts (upline_id, position) WHERE upline_id > 0;
CREATE INDEX IF NOT EXISTS idx_accounts_user            ON accounts (user_id);
CREATE INDEX IF NOT EXISTS idx_accounts_upline_position ON accounts (upline_id, position);
CREATE INDEX IF NOT EXISTS idx_accounts_user_type       ON accounts (user_id, account_type);
CREATE INDEX IF NOT EXISTS idx_accounts_sponsor         ON accounts (sponsor_id);
CREATE INDEX IF NOT EXISTS idx_accounts_status          ON accounts (status);

-- ---------------------------------------------------------------------
-- Activation codes / e-pins (wp_mlm_pins)
-- is_product = 0 -> registration package code
-- is_product = 1 -> retail product code (drives Unilevel LP)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pins (
  id                    BIGSERIAL PRIMARY KEY,
  pin_code              VARCHAR(50) NOT NULL UNIQUE,
  package_type          VARCHAR(100) NOT NULL DEFAULT 'Premium',
  is_product            SMALLINT    NOT NULL DEFAULT 0,
  purchaser_id          BIGINT      NOT NULL DEFAULT 0,
  status                VARCHAR(20) NOT NULL DEFAULT 'unused' CHECK (status IN ('unused','used','pending_payment')),
  used_by               BIGINT,
  used_at               TIMESTAMPTZ,
  activation_source     VARCHAR(20),                 -- member | admin
  activated_by_user_id  BIGINT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pins_purchaser_status_product ON pins (purchaser_id, status, is_product);
CREATE INDEX IF NOT EXISTS idx_pins_used_by                  ON pins (used_by);
CREATE INDEX IF NOT EXISTS idx_pins_activated_by             ON pins (activated_by_user_id);
CREATE INDEX IF NOT EXISTS idx_pins_activation_source        ON pins (activation_source);
CREATE INDEX IF NOT EXISTS idx_pins_created                  ON pins (created_at);

-- ---------------------------------------------------------------------
-- Earnings + withdrawals ledger (wp_mlm_ledger)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ledger (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT        NOT NULL,
  amount         NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_deducted   NUMERIC(18,2) NOT NULL DEFAULT 0,
  fee_deducted   NUMERIC(18,2) NOT NULL DEFAULT 0,
  type           VARCHAR(10)   NOT NULL DEFAULT 'cash' CHECK (type IN ('cash','gc','hang')),
  status         VARCHAR(10)   NOT NULL DEFAULT 'active' CHECK (status IN ('active','hang','released')),
  note           TEXT          NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ledger_user_created      ON ledger (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ledger_user_type_status  ON ledger (user_id, type, status);
CREATE INDEX IF NOT EXISTS idx_ledger_created           ON ledger (created_at);

-- ---------------------------------------------------------------------
-- Orders (registration packages + retail products) (wp_mlm_orders)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT      NOT NULL,
  order_details  TEXT        NOT NULL,
  proof_image    VARCHAR(255) NOT NULL DEFAULT '',
  status         VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_user_status_created ON orders (user_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_status              ON orders (status);

-- ---------------------------------------------------------------------
-- Packages + retail products (wp_mlm_packages)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS packages (
  id           BIGSERIAL PRIMARY KEY,
  pkg_name     VARCHAR(100) NOT NULL,
  pkg_price    NUMERIC(18,2) NOT NULL DEFAULT 0,
  pkg_desc     TEXT NOT NULL DEFAULT '',
  pkg_variants TEXT NOT NULL DEFAULT '',
  is_product   SMALLINT NOT NULL DEFAULT 0,
  status       SMALLINT NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_packages_product_status ON packages (is_product, status);

-- ---------------------------------------------------------------------
-- Activity / audit logs (wp_mlm_audit_logs)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id              BIGSERIAL PRIMARY KEY,
  actor_user_id   BIGINT       NOT NULL DEFAULT 0,
  actor_username  VARCHAR(100) NOT NULL DEFAULT '',
  actor_role      VARCHAR(30)  NOT NULL DEFAULT 'member',
  category        VARCHAR(50)  NOT NULL DEFAULT 'system',
  action          VARCHAR(190) NOT NULL DEFAULT '',
  target_user_id  BIGINT       NOT NULL DEFAULT 0,
  target_username VARCHAR(100) NOT NULL DEFAULT '',
  details         TEXT         NOT NULL DEFAULT '',
  ip_address      VARCHAR(60)  NOT NULL DEFAULT '',
  user_agent      TEXT         NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_category   ON audit_logs (category);
CREATE INDEX IF NOT EXISTS idx_audit_actor      ON audit_logs (actor_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_created    ON audit_logs (created_at);

-- ---------------------------------------------------------------------
-- System settings (replaces wp_options mlm_sys_* keys)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key        VARCHAR(80) PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Batch rebuild progress (Admin -> Start Batch Recalculate)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rebuild_state (
  id         SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  batch_id   BIGINT      NOT NULL DEFAULT 1,
  step       SMALLINT    NOT NULL DEFAULT 0,
  row_offset BIGINT      NOT NULL DEFAULT 0,
  total      BIGINT      NOT NULL DEFAULT 0,
  status     VARCHAR(20) NOT NULL DEFAULT 'idle',
  message    TEXT        NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO rebuild_state (id, batch_id, step, row_offset, total, status, message)
VALUES (1, 1, 0, 0, 0, 'idle', '')
  ON CONFLICT (id) DO NOTHING;
