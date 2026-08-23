import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // Build output, and code we did not write. `server/src/generated` is the
  // Prisma client and the Nexus typegen — 387 of this config's 394 errors came
  // from those two, which is enough noise to make `bun run lint` useless as a
  // signal and is why it was failing with nothing wrong. They are regenerated
  // from `schema.prisma` on every `server:prepare`, so there is nothing to fix
  // in them even in principle.
  globalIgnores(['dist', 'server/src/generated']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs['recommended-latest'],
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
])
