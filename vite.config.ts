import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src/web", import.meta.url)) } },
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist" },
});
