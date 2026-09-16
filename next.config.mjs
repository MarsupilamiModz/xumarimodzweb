import createNextIntlPlugin from "next-intl/plugin";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

// Gives `next dev` access to Cloudflare bindings (Hyperdrive, etc.) via
// getCloudflareContext(), matching what the deployed Worker sees. Must not
// run during `next build`/`next start` (the PM2/Docker path) — with
// wrangler.jsonc present it would otherwise try to proxy the Hyperdrive
// binding and fail without a local Postgres connection string configured.
if (process.env.NODE_ENV === "development") {
  initOpenNextCloudflareForDev();
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**.supabase.co" },
      { protocol: "https", hostname: "**.r2.cloudflarestorage.com" },
      { protocol: "https", hostname: "**.r2.dev" },
      { protocol: "https", hostname: "**.cloudflare.com" },
      { protocol: "https", hostname: "**.cloudflarecdn.com" },
      { protocol: "https", hostname: "**.workers.dev" },
      { protocol: "https", hostname: "**.xumari-modz.com" },
      { protocol: "https", hostname: "**.xumarimodz.com" },
      { protocol: "https", hostname: "**.marsupilami-modz.com" },
      { protocol: "https", hostname: "**.marsupilamimodz.com" },
      { protocol: "http", hostname: "localhost" },
      { protocol: "https", hostname: "127.0.0.1" },
      { protocol: "https", hostname: "img.youtube.com" },
      { protocol: "https", hostname: "i.ytimg.com" },
    ],
    formats: ["image/avif", "image/webp"],
    minimumCacheTTL: 86400,
    deviceSizes: [640, 750, 828, 1080, 1200],
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
  },
  experimental: {
    serverActions: { bodySizeLimit: "10mb" },
    optimizePackageImports: [
      "lucide-react",
      "recharts",
      "date-fns",
      "@radix-ui/react-dialog",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-select",
      "@radix-ui/react-tabs",
    ],
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // `pg`/`@prisma/adapter-pg` (used by src/lib/db.ts's Cloudflare/Hyperdrive
      // path) pull in Node builtins that don't exist in the browser. Client
      // components never actually reach that code path — some just happen to
      // import a lib module that also imports db.ts for unrelated server-only
      // exports — so it's safe to stub these out for the client bundle.
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
        dns: false,
        "util/types": false,
      };
    }
    return config;
  },
  async headers() {
    return [
      {
        source: "/_next/static/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
      {
        source: "/favicon.ico",
        headers: [{ key: "Cache-Control", value: "public, max-age=86400" }],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
