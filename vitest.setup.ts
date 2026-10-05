// Loads .env.test first (if present) and then .env, without overriding what CI already set.
import { config } from 'dotenv'

config({ path: '.env.test' })
config()

// Collection hooks must not need Redis in integration tests; the engine is tested directly.
process.env.MARMOT_DISABLE_ENGINE_HOOKS ??= '1'
