import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/* The dashboard is a React app built by Vite into dist/. The serverless functions in api/ are not
   part of the build — Vercel deploys them alongside it. In development, `npm run dev` serves the app
   and forwards /api to the local API server (`npm run api`, dev-server.js on port 3000). */
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": "http://localhost:3000" } },
  /* the shipped bundle: minified, no source maps, no comments — nothing in it is secret (keys and the
     admin's data stay on the server, behind admin-auth.js), but there is no reason to hand out a map */
  build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 900 },
  esbuild: { legalComments: "none", drop: ["debugger"] },
});
