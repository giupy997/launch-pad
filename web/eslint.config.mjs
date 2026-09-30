import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Reading storage or the URL into state when a component mounts is how
      // these pages come alive; without the React Compiler the rule's cascade
      // is one extra render, made on purpose.
      "react-hooks/set-state-in-effect": "off",
    },
  },
  // Deno code run by Netlify's edge, and build output, are not this project's TypeScript
  globalIgnores([".next/**", "netlify/**", "node_modules/**", "next-env.d.ts"]),
]);
