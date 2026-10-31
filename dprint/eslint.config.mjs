// Lint config for the TypeScript sources in src/. plugin/ is build output (minified .mjs) and is never linted.
import js from "@eslint/js";
import jsdoc from "eslint-plugin-jsdoc";
import tsdoc from "eslint-plugin-tsdoc";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["plugin/**"] },
  {
    files: ["src/**/*.{ts,mts}"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
      jsdoc.configs["flat/recommended-typescript-error"],
    ],
    plugins: { tsdoc },
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    settings: { jsdoc: { mode: "typescript" } },
    rules: {
      // TSDoc syntax (`@param name - text`, `@remarks`, `@returns`, …)
      "tsdoc/syntax": "error",
      "jsdoc/require-hyphen-before-param-description": "error",
      // TSDoc style: one blank line between the description and the first tag
      "jsdoc/tag-lines": ["error", "any", { startLines: 1 }],
      // every function, method, class, type and module-level constant carries a doc comment, exported or not
      "jsdoc/require-jsdoc": [
        "error",
        {
          publicOnly: false,
          require: {
            FunctionDeclaration: true,
            MethodDefinition: true,
            ClassDeclaration: true,
            ArrowFunctionExpression: false,
            FunctionExpression: false,
          },
          contexts: [
            "Program > VariableDeclaration",
            // an exported const carries its comment on the export statement
            'ExportNamedDeclaration[declaration.type="VariableDeclaration"]',
            "TSTypeAliasDeclaration",
            "TSInterfaceDeclaration",
            "ClassBody > PropertyDefinition",
          ],
          checkConstructors: false,
        },
      ],
      "jsdoc/require-description": ["error", { contexts: ["any"] }],
      // TSDoc has no dotted `@param opts.x` names; document an options object's fields on its type instead
      "jsdoc/require-param": ["error", { checkDestructured: false }],
      "jsdoc/check-param-names": ["error", { checkDestructured: false }],
      // the hook payloads are untyped JSON from Claude Code; `any` is the honest type at that boundary
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
);
