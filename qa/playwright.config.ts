import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.PORT ?? 8799);
const BASE = process.env.BASE ?? `http://localhost:${PORT}`;

// ponytail: serial, 1 worker. Every test hits live devnet/mainnet public RPCs, which rate-limit per IP.
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 60_000 },
  reporter: [["list"], ["json", { outputFile: "results.json" }]],
  use: { baseURL: BASE, trace: "off", screenshot: "only-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 }, channel: process.env.PW_CHANNEL || undefined } },
    { name: "mobile", use: { ...devices["Desktop Chrome"], viewport: { width: 375, height: 800 }, isMobile: false, channel: process.env.PW_CHANNEL || undefined } },
  ],
  webServer: process.env.BASE ? undefined : {
    // cwd = repo root: api/_rambu.ts readData() resolves web/data from process.cwd()
    command: `node qa/server.ts`,
    cwd: new URL("../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
    env: { PORT: String(PORT) },
    url: BASE,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
