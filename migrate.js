import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import pg from 'pg'
import 'dotenv/config'

const { Pool } = pg
const __dirname = dirname(fileURLToPath(import.meta.url))

async function migrate() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })

  try {
    // Guard: abort if data already exists to prevent accidental wipe
    const { rows } = await pool.query(
      `SELECT COUNT(*) FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'agents'`
    )
    if (rows[0].count > 0 && !process.argv.includes('--force')) {
      console.log('⚠️  Table "agents" already exists. Pass --force to wipe and recreate.')
      console.log('   Example: node migrate.js --force')
      await pool.end()
      return
    }

    const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8')
    console.log('Running migrations...')
    await pool.query(schema)
    console.log('✅ Migration complete')
  } catch (e) {
    console.error('Migration failed:', e.message)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

migrate()
