-- 002_issue_flag.sql — mark a return request as a complaint or a legal case.
-- NULL issue_type = neither (default for every existing row).
ALTER TABLE return_requests
  ADD COLUMN IF NOT EXISTS issue_type      TEXT,
  ADD COLUMN IF NOT EXISTS issue_note      TEXT,
  ADD COLUMN IF NOT EXISTS issue_marked_by TEXT,
  ADD COLUMN IF NOT EXISTS issue_marked_at TIMESTAMPTZ;

ALTER TABLE return_requests
  DROP CONSTRAINT IF EXISTS return_requests_issue_type_check;

ALTER TABLE return_requests
  ADD CONSTRAINT return_requests_issue_type_check
  CHECK (issue_type IS NULL OR issue_type IN ('complaint','case'));

CREATE INDEX IF NOT EXISTS idx_return_issue
  ON return_requests(issue_type) WHERE issue_type IS NOT NULL;
