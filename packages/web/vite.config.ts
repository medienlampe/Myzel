import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // Relative asset URLs, so the built UI also works behind a path-prefixing
  // reverse proxy (https://host/myzel/), not only at the site root. API calls
  // resolve the same way — see apiUrl() in src/api.ts.
  base: "./",
  plugins: [react(), tailwindcss()],
  server: {
    port: 5180,
    proxy: {
      "/api": "http://localhost:3800",
      "/mcp": "http://localhost:3800",
    },
  },
});
