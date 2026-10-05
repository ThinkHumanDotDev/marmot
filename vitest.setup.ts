// Loads .env.test first (if present) and then .env, without overriding what CI already set.
import { config } from 'dotenv'

config({ path: '.env.test' })
config()
