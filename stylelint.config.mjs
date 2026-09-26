// Official Obsidian CSS ruleset: the rules the community plugin review scanner
// runs over styles.css, on top of stylelint-config-standard.
/** @type {import("stylelint").Config} */
export default {
    extends: ["stylelint-config-obsidianmd"],
    rules: {
        // The preset checks browser support against Electron 43 (Obsidian
        // 1.13.4), but the review scanner has reported against Electron 39
        // (Obsidian 1.11.4). The older target is checked here so that nothing
        // the scanner flags passes locally. The options restate the preset's
        // own, since a rule's options are replaced rather than merged.
        "plugin/no-unsupported-browser-features": [
            true,
            {
                severity: "warning",
                browsers: ["electron >= 39"],
                ignore: ["css-nesting", "css-cascade-layers"],
            },
        ],
        // The plugin also runs on Obsidian mobile, where iOS Safari (through 27.x)
        // supports these two properties only with the -webkit- prefix. Dropping the
        // prefix would break text selection and highlight wrapping on iPhone and
        // iPad. Obsidian's own stylesheet ships both prefixes for the same reason.
        "property-no-vendor-prefix": [
            true,
            // Matched against the property as written, so the prefixed names.
            { ignoreProperties: ["-webkit-user-select", "-webkit-box-decoration-break"] },
        ],
        // Range syntax (`width <= 520px`) needs iOS Safari 16.4+; an older WebView
        // drops the whole query and loses the phone layout. Obsidian's own
        // stylesheet uses the prefix form too.
        "media-feature-range-notation": "prefix",
    },
};
