-- Create both databases on first init
-- PostgreSQL will already create treasurio_prod (POSTGRES_DB),
-- so we only need to create the dev database.

CREATE DATABASE treasurio_dev OWNER treasurio;
