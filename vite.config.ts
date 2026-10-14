import { defineConfig } from "vite";

// A relative base ("./") works on GitHub Pages for any repository name,
// so no change is needed when you name or rename the repo.
export default defineConfig({
  base: "./",
  build: {
    target: "es2020",
    chunkSizeWarningLimit: 1500,
  },
});
