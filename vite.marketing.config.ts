import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  root: path.resolve(__dirname, "marketing"),
  publicDir: path.resolve(__dirname, "public"),
  plugins: [react(), tailwindcss()],
  build: {
    outDir: path.resolve(__dirname, "marketing-dist"),
    emptyOutDir: true,
  },
})
