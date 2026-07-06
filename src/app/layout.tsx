import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { CrawlStatusBadge } from "@/components/CrawlStatusBadge";
import { ThemeScript } from "@/components/ThemeScript";
import { ThemeSync } from "@/components/ThemeSync";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "santi's list",
  description: "Craigslist apartment listing watcher and alerts",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <ThemeScript />
      </head>
      <body className="min-h-full flex flex-col">
        <ThemeSync />
        <header className="border-b border-black/10 dark:border-white/15">
          <nav className="mx-auto max-w-5xl flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 text-sm">
            <Link href="/" className="font-semibold flex items-center gap-1.5 whitespace-nowrap">
              <span aria-hidden>🍉</span>
              <span className="text-lg" style={{ fontFamily: '"Times New Roman", Times, serif' }}>santi&apos;s list</span>
            </Link>
            <Link href="/" className="text-black/70 dark:text-white/70 hover:underline whitespace-nowrap">
              Listings
            </Link>
            <Link href="/map" className="text-black/70 dark:text-white/70 hover:underline whitespace-nowrap">
              Map
            </Link>
            <Link href="/watches" className="text-black/70 dark:text-white/70 hover:underline whitespace-nowrap">
              Saved Searches
            </Link>
            <Link href="/rent-map" className="text-black/70 dark:text-white/70 hover:underline whitespace-nowrap">
              Rent Map
            </Link>
            <Link href="/settings" className="text-black/70 dark:text-white/70 hover:underline whitespace-nowrap">
              Settings
            </Link>
            <span className="ml-auto whitespace-nowrap">
              <CrawlStatusBadge />
            </span>
          </nav>
        </header>
        <div className="border-b border-black/10 dark:border-white/15 bg-black/[.02] dark:bg-white/[.03]">
          <p className="mx-auto max-w-5xl px-4 py-2 text-xs text-black/50 dark:text-white/50">
            this app automatically crawls craigslist for apartments based on your preferences, organizes them,
            and alerts you when new listings go up. pls don&apos;t abuse my data limits :)
          </p>
        </div>
        <main className="flex-1 mx-auto w-full max-w-5xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
