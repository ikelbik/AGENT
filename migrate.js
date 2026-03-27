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
