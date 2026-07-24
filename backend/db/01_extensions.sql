-- AgroLink Platform — required PostgreSQL extensions.
-- Both ship with standard Postgres installs and are supported by Render's
-- managed Postgres (PostgreSQL 13+) via CREATE EXTENSION.
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS postgis;
