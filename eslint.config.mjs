import obsidianmd from "eslint-plugin-obsidianmd";

export default [
    {
        // Build output, vendored shims, deployed functions, tooling configs,
        // and deps are not part of the plugin source under review.
        ignores: [
            "node_modules/**",
            "main.js",
            "cloud-functions/**",
            "shims/**",
            "**/*.mjs",
            "tests/**",
        ],
    },
    ...obsidianmd.configs.recommended,
    {
        // The obsidianmd recommended preset turns on type-checked rules for
        // TypeScript files but leaves the project wiring to the consumer.
        files: ["**/*.ts", "**/*.tsx"],
        languageOptions: {
            // Buffer is a Node global made available at runtime by the esbuild
            // buffer shim (see esbuild.config.mjs `inject`).
            globals: { Buffer: "readonly" },
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
    {
        // The preset also enables every obsidian rule globally and lints
        // package.json. The type-aware rules below need the TypeScript parser
        // service, which doesn't exist for JSON, so turn them off there.
        files: ["package.json"],
        rules: {
            "obsidianmd/no-plugin-as-component": "off",
            "obsidianmd/no-unsupported-api": "off",
            "obsidianmd/no-view-references-in-plugin": "off",
            "obsidianmd/prefer-file-manager-trash-file": "off",
            "obsidianmd/prefer-instanceof": "off",
        },
    },
];
