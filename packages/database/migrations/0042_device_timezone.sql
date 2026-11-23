-- Old choices retain their saved zone. New profiles initialize in device mode.
ALTER TABLE finance.assistant_profile ADD COLUMN follows_device boolean NOT NULL DEFAULT false;
