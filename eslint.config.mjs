import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Agent backend (plain ESM, runs on Bun) + the extracted CLI bundle / dev scripts.
    "lib/**",
    "bin/**",
    "scripts/**",
    "local.mjs",
    // Vercel build output contains 16MB cli.js copies that OOM eslint.
    ".vercel/**",
    // Vendored verbatim from the shadcn / ai-elements registries — not ours to lint.
    "components/ui/**",
    "components/ai-elements/**",
  ]),
]);

export default eslintConfig;
