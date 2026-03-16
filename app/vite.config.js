import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const appRoot = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = path.resolve(appRoot, "..");

export default defineConfig({
  plugins: [react()],
  define: {
    global: "globalThis",
  },
  server: {
    fs: {
      allow: [repoRoot],
    },
  },
  resolve: {
    alias: {
      "@target": path.join(repoRoot, "target"),
    },
  },
});
