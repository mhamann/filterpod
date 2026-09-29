import { defineConfig } from "vitest/config";

export default defineConfig({
  // Wrangler bundles .md files as text (see wrangler.jsonc); do the same under test.
  plugins: [
    {
      name: "markdown-as-text",
      transform(code, id) {
        if (id.endsWith(".md")) return { code: `export default ${JSON.stringify(code)};`, map: null };
      },
    },
  ],
});
