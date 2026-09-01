/**
 * Side-effect module: loads the env file into process.env BEFORE any Nest module
 * metadata is evaluated. It is imported FIRST in main.ts — static imports run in the
 * order they appear, so everything imported after it (AppModule → OrdersModule → …)
 * already sees the file's values.
 *
 * Why not rely on ConfigModule alone: it reads the file inside NestFactory.create(),
 * i.e. AFTER module metadata has been evaluated — and metadata is where providers are
 * picked by env (OrdersModule chooses the order channel, AppModule the demo module).
 * A variable set only in the file would be invisible there.
 *
 * ENV_FILE picks which file to read (`.env` by default) — that is how the demo stand
 * runs locally: `ENV_FILE=.env.demo npm run start:dev`. Real environment variables
 * always win (dotenv never overrides them), so in Docker the compose `environment:`
 * block stays authoritative.
 */
import { config } from 'dotenv';

/** Path of the env file this process was started with (for logs and ConfigModule). */
export const ENV_FILE = process.env.ENV_FILE?.trim() || '.env';

config({ path: ENV_FILE, quiet: true });
