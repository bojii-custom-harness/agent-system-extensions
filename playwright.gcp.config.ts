import { defineConfig } from "@playwright/test";

export default defineConfig({
  expect: { timeout: 5_000 },
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  reporter: [["list"]],
  testDir: "./packages/google-cloud-platform/tests",
  testMatch: "google-cloud-platform-login.spec.ts",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:5174",
    headless: true,
  },
  workers: 1,
});
