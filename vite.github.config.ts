import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const repositoryName =
  process.env.GITHUB_REPOSITORY?.split("/").at(-1) ?? "xuanzhuan-zhihou";
const base = process.env.GITHUB_ACTIONS === "true" ? `/${repositoryName}/` : "/";

export default defineConfig({
  base,
  plugins: [react()],
  publicDir: "public",
  build: {
    outDir: "github-pages-dist",
    emptyOutDir: true,
  },
});
