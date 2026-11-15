import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Relative asset paths: the build works at a domain root and under a sub-path (GitHub Pages).
  base: "./",
  plugins: [react()],
  // The whitepaper pages live in ../docs and are imported as text.
  server: { port: 5173, strictPort: true, fs: { allow: [".."] } },
});
