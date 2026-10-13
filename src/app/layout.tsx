import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({ subsets: ['latin'], display: 'swap', variable: '--font-inter' });

export const metadata: Metadata = {
  title: 'MJPremium Ultimate MLM System',
  description:
    'Strict manual placement (MA → CA → MA), hybrid point/node pairing, CA separation, dynamic-compression unilevel and advanced reporting.',
  applicationName: 'MJPremium',
  keywords: ['MLM', 'genealogy', 'pairing', 'unilevel', 'Philippines'],
};

export const viewport: Viewport = {
  themeColor: '#000000',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-screen bg-bg font-sans text-zinc-100 antialiased">{children}</body>
    </html>
  );
}
