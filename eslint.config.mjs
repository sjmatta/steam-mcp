import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

/**
 * Type-aware linting. The rules that earn their keep here are the async ones:
 * this codebase is almost entirely promises talking to a socket, a rate
 * limiter and a serialisation queue, and a floating promise in any of those is
 * a silently dropped Steam write.
 */
export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "node_modules/**", "test/fixtures/**"] },

  js.configs.recommended,

  // Plain-JS files (this config, the smoke script) are in no tsconfig, so the
  // type-aware rules cannot apply and Node's globals must be declared.
  {
    files: ["**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { globals: globals.nodeBuiltin },
  },

  {
    files: ["**/*.ts"],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        // tsconfig.json covers only src (it is the build config). The check
        // config is the one that also knows about tests and *.config.ts.
        project: ["./tsconfig.check.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      // stdout is the MCP protocol channel; anything written there corrupts
      // the JSON-RPC stream and drops the client connection.
      "no-console": ["error", { allow: ["error"] }],
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "stdout",
          message: "stdout is the MCP protocol channel. Log to stderr (console.error).",
        },
      ],

      // Unused args are usually a signature we must keep; unused locals are not.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],

      // Steam's page objects are genuinely `any` at the boundary, and errors
      // arrive as `unknown`. Both are handled explicitly at the call sites.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true, allowNullish: true },
      ],

      // These fire constantly on defensive parsing of files Steam wrote, where
      // a "provably non-null" value is only non-null if Steam behaved.
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/prefer-nullish-coalescing": "off",

      // Reading a JSON blob or a VDF node through an index signature is a
      // lookup, not property access, and bracket notation says so.
      "@typescript-eslint/dot-notation": ["error", { allowIndexSignaturePropertyAccess: true }],

      // `Array<() => Promise<T>>` is more readable than the postfix form, and
      // both appear deliberately.
      "@typescript-eslint/array-type": "off",

      // The cache is intentionally "caller asserts the shape": `get<T>()` has
      // no argument to infer from, which is the whole point of the API.
      "@typescript-eslint/no-unnecessary-type-parameters": "off",

      // `async` here is signature conformance, not a mistake: MCP tool
      // handlers, the fake Steam client and fetch stubs all have to return
      // promises because the things they stand in for do.
      "@typescript-eslint/require-await": "off",

      // A no-op default callback is the clearest way to say "optional hook".
      "@typescript-eslint/no-empty-function": ["error", { allow: ["arrowFunctions"] }],

      // tsconfig sets noUncheckedIndexedAccess, so `!` after an explicit
      // length or regex-match check is the intended escape hatch, not a
      // shortcut around the type system.
      "@typescript-eslint/no-non-null-assertion": "off",

      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/return-await": ["error", "in-try-catch"],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
    },
  },

  /**
   * In-page programs are shipped to Steam's Chromium context via
   * Function.prototype.toString(). They therefore cannot reference module
   * scope, and any import would emit an identifier the page cannot resolve.
   * `auditPageFunction` enforces this at runtime; this catches it at edit time.
   */
  {
    files: ["src/cdp/programs/*.ts"],
    ignores: ["src/cdp/programs/types.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportDeclaration:not([importKind='type'])",
          message:
            "Page programs run inside Steam's page. Only `import type` is allowed - a value import becomes an unresolvable identifier there.",
        },
      ],

      /**
       * Everything these functions touch - collectionStore, appStore,
       * SteamClient, AppOverview - is Valve's, undeclared, and reshaped by
       * Steam updates without notice. There is nothing to type against, and
       * inventing declarations would assert a contract we cannot enforce; the
       * programs validate at runtime and return a structured error instead.
       * This is the only place in the repo where the unsafe-* rules are off.
       */
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },

  {
    files: ["test/**/*.ts"],
    rules: {
      // Tests deliberately poke at malformed and loosely typed shapes.
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/unbound-method": "off",
      "no-console": "off",
      // fake-steam.ts captures `this` on purpose: Steam's real stores hand out
      // bound closures, and the fake has to behave the same way.
      "@typescript-eslint/no-this-alias": "off",
    },
  },

  prettier,
);
