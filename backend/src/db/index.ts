import { Pool } from 'pg'
import { config } from '../config'

export const db = new Pool(config.db)

export async function runMigrations(): Promise<void> {
  const client = await db.connect()
  try {
    // ── Create tables ──────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id          SERIAL PRIMARY KEY,
        username    VARCHAR(100) UNIQUE NOT NULL,
        password    VARCHAR(255) NOT NULL,
        role        VARCHAR(20) NOT NULL DEFAULT 'admin'
                    CHECK (role IN ('superadmin', 'admin', 'moderator')),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS known_players (
        id               SERIAL PRIMARY KEY,
        beammp_username  VARCHAR(100) UNIQUE NOT NULL,
        connection_count INTEGER NOT NULL DEFAULT 0,
        first_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen        TIMESTAMPTZ,
        total_seconds    INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS account_requests (
        id               SERIAL PRIMARY KEY,
        beammp_username  VARCHAR(100) NOT NULL,
        requested_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        status           VARCHAR(20) NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'approved', 'rejected')),
        reviewed_by      INTEGER REFERENCES users(id),
        reviewed_at      TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS mods (
        id          SERIAL PRIMARY KEY,
        instance_id VARCHAR(50)  NOT NULL DEFAULT 'default',
        name        VARCHAR(255) NOT NULL,
        type        VARCHAR(20)  NOT NULL CHECK (type IN ('mod', 'vehicle', 'map')),
        filename    VARCHAR(255) NOT NULL,
        image       VARCHAR(255),
        description JSONB,
        active      BOOLEAN NOT NULL DEFAULT true,
        map_id      VARCHAR(100),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        is_official BOOLEAN NOT NULL DEFAULT false,
        UNIQUE (instance_id, filename)
      );
    `)

    // ── Idempotent migrations ──────────────────────────────────
    await client.query(`
      DO $$
      BEGIN
        -- description TEXT → JSONB
        IF (
          SELECT data_type FROM information_schema.columns
          WHERE table_name = 'mods' AND column_name = 'description'
        ) = 'text' THEN
          ALTER TABLE mods ALTER COLUMN description TYPE jsonb
          USING CASE
            WHEN description IS NULL OR description = '' THEN NULL
            ELSE jsonb_build_object('fr', description)
          END;
          RAISE NOTICE 'description migrated TEXT → JSONB';
        END IF;

        -- add instance_id if missing (pre-existing installs)
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'mods' AND column_name = 'instance_id'
        ) THEN
          ALTER TABLE mods ADD COLUMN instance_id VARCHAR(50) NOT NULL DEFAULT 'default';
          RAISE NOTICE 'instance_id column added to mods';
        END IF;

        -- remove old unique constraint on filename alone (now unique per instance)
        IF EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_name = 'mods' AND constraint_name = 'mods_filename_key'
        ) THEN
          ALTER TABLE mods DROP CONSTRAINT mods_filename_key;
          RAISE NOTICE 'Dropped old unique constraint mods_filename_key';
        END IF;

        -- add is_official if missing
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'mods' AND column_name = 'is_official'
        ) THEN
          ALTER TABLE mods ADD COLUMN is_official BOOLEAN NOT NULL DEFAULT false;
          RAISE NOTICE 'is_official column added to mods';
        END IF;
      END $$;
    `)

    console.log('[db] Migrations OK')
  } finally {
    client.release()
  }
}
