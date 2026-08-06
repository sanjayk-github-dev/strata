import type { NextConfig } from "next";

const config: NextConfig = {
  // The pipeline reads and writes a local cache directory and parses multi-MB XML; it is
  // server-only by construction and must never be bundled for the browser.
  serverExternalPackages: ["sax"],

  webpack: (config) => {
    /**
     * Resolve ESM-style `.js` specifiers to their TypeScript sources.
     *
     * The pipeline is a plain ESM TypeScript library — `"type": "module"` — so its
     * internal imports must carry `.js` extensions for Node, tsx, and vitest to resolve
     * them. Webpack does not apply that mapping by default, so importing the library from
     * a route fails on its *internal* imports even once the entry point resolves.
     *
     * Teaching the bundler is the right fix. Stripping the extensions from the library
     * would make it unrunnable outside Next, breaking the local-first constraint the
     * architecture rests on (docs/TDD.md §2): the CLI and the test suite import these same
     * modules directly, with no bundler involved.
     */
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias as Record<string, string[]> | undefined),
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default config;
