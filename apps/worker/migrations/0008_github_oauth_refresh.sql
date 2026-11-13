ALTER TABLE personal_github ADD COLUMN refresh_credential TEXT;
ALTER TABLE personal_github ADD COLUMN expires_at INTEGER;
ALTER TABLE personal_github ADD COLUMN refresh_expires_at INTEGER;
ALTER TABLE personal_github ADD COLUMN credential_generation TEXT NOT NULL DEFAULT '';
ALTER TABLE personal_github ADD COLUMN refresh_lock TEXT;
ALTER TABLE personal_github ADD COLUMN refresh_lock_until INTEGER;
