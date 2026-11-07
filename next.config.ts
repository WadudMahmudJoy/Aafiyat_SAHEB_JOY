import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() { return [{ source: "/staff/accept-invitation", headers: [{ key: "Cache-Control", value: "no-store, private" },{ key: "Referrer-Policy", value: "no-referrer" },{ key: "X-Robots-Tag", value: "noindex, nofollow" },{ key: "X-Frame-Options", value: "DENY" }] }]; },
  experimental: {
    agentUpgrade: "security",
    serverActions: { bodySizeLimit: "9mb" },
  },
};

// Separate build output for the disposable authenticated inventory test server.
// The normal app remains on .next; this opt-in cannot target the development DB.
const inventoryTestRun = process.env.AAFIYAT_INVENTORY_TEST_RUN;
if (inventoryTestRun) {
  const database = new URL(process.env.DATABASE_URL ?? "");
  if (!/^[a-f0-9-]{36}$/.test(inventoryTestRun) || database.hostname !== "127.0.0.1" || database.port === "55432" ||
      database.pathname !== `/receive_verify_${inventoryTestRun.replaceAll("-", "")}`) throw new Error("Invalid isolated inventory test environment.");
  nextConfig.distDir = `.local/inventory-a1-build-${inventoryTestRun}`;
}

export default nextConfig;
