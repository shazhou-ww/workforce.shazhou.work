ALTER TABLE personal_users ADD COLUMN public_slug TEXT COLLATE NOCASE;
CREATE UNIQUE INDEX personal_public_slug ON personal_users(public_slug) WHERE public_slug IS NOT NULL;
