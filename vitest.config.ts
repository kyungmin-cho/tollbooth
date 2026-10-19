import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          APP_ORIGIN: "http://127.0.0.1:8787",
          PAYPAL_CLIENT_ID: "test-client",
          PAYPAL_CLIENT_SECRET: "test-secret",
          PAYPAL_MERCHANT_ID: "TEST-MERCHANT",
          OWNER_TOKEN_SIGNING_KEY: "test-only-signing-key-not-a-real-secret-1234",
          MERCHANT_ADMIN_TOKEN: "test-merchant-admin-secret-0000000000000000",
          MERCHANT_COOKIE_SIGNING_KEY: "test-merchant-cookie-signing-key-00000000000",
          TEST_MIGRATIONS: await readD1Migrations("./migrations/d1"),
        },
      },
    }),
  ],
  test: { setupFiles: ["./tests/setup.ts"], include: ["tests/**/*.test.ts"], testTimeout: 15000 },
});
