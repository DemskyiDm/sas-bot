-- Auth table for coordinators
CREATE TABLE coordinator_auth (
  id             SERIAL PRIMARY KEY,
  coordinator_id INT          NOT NULL REFERENCES coordinators(id) ON DELETE CASCADE,
  username       VARCHAR(50)  NOT NULL UNIQUE,
  password_hash  TEXT         NOT NULL,
  is_admin       BOOLEAN      NOT NULL DEFAULT false,
  last_login     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_auth_username ON coordinator_auth(username);
