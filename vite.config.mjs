import { resolve } from "node:path";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig(({ mode }) => {
  const background = mode === "background";

  return {
    plugins: background ? [] : [vue()],
    publicDir: background ? false : "public",
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
    build: {
      outDir: "dist",
      emptyOutDir: !background,
      cssCodeSplit: false,
      minify: true,
      sourcemap: false,
      lib: {
        entry: resolve(
          process.cwd(),
          background ? "src/extension/background.ts" : "src/extension/content.ts",
        ),
        name: background ? "SpoilerBarrageBackground" : "SpoilerBarrageContent",
        formats: ["iife"],
        fileName: () => (background ? "background.js" : "content.js"),
      },
      rollupOptions: {
        output: {
          assetFileNames: (assetInfo) =>
            assetInfo.name?.endsWith(".css") ? "content.css" : "assets/[name][extname]",
        },
      },
    },
  };
});
