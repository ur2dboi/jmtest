/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // `pg` is a native-ish node driver: keep it out of the client bundle and
  // let Vercel trace it into the serverless function.
  serverExternalPackages: ['pg', 'bcryptjs'],
  output: process.env.VERCEL ? undefined : undefined,
  experimental: {
    // Larger bodies are needed for the admin JSON backup restore upload.
    serverActions: { bodySizeLimit: '25mb' },
  },
};

export default nextConfig;
