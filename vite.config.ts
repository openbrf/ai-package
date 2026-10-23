import { federation } from "@module-federation/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * A chunk's name, cut short and in the characters the catalog's reader takes
 * in a path segment: a letter or digit first, then letters, digits, `.`, `_`
 * and `-`.
 */
function shortName(name: string): string {
  const cut = name
    .replace(/\.[^.]*$/, "")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 40);
  return cut === "" ? "chunk" : cut;
}

/**
 * The view's build: a Module Federation 2.0 remote the host loads at runtime
 * (the plugin contract, "The client entry point").
 *
 * The remote's name is the plugin id and the exposed module is the manifest's
 * `view.module`. React, ReactDOM, react-i18next and i18next are shared
 * singletons, the four the host shares: a second copy of React would give the
 * view its own hook dispatcher, and a second i18next a resource store the
 * package's translations were never merged into. `requiredVersion: false`
 * because the view runs in a host whose exact versions it was not built
 * against.
 *
 * Built before the server bundle, which `scripts/build.mjs` then writes into
 * the same directory.
 */
export default defineConfig({
  plugins: [
    react(),
    federation({
      name: "ai-package",
      filename: "remoteEntry.js",
      exposes: { "./View": "./src/view/View.tsx" },
      shared: {
        react: { singleton: true, requiredVersion: false },
        "react-dom": { singleton: true, requiredVersion: false },
        "react-i18next": { singleton: true, requiredVersion: false },
        i18next: { singleton: true, requiredVersion: false },
      },
      // The host loads the remote from its manifest at runtime, so a type
      // archive would only be dead weight in the tarball.
      dts: false,
    }),
  ],
  build: {
    target: "esnext",
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      // No input of its own: the federation plugin emits the remote entry.
      input: {},
      output: {
        // The catalog reads the tarball with a strict reader that refuses a
        // path segment not starting with a letter or a digit, and the long
        // names the federation plugin gives its virtual modules.
        chunkFileNames: (chunk) => `assets/${shortName(chunk.name)}-[hash].js`,
        assetFileNames: (asset) =>
          `assets/${shortName(asset.names[0] ?? "asset")}-[hash][extname]`,
      },
    },
  },
});
