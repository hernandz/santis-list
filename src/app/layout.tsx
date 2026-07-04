import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { CrawlStatusBadge } from "@/components/CrawlStatusBadge";
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
    >
      <body className="min-h-full flex flex-col">
        <header className="border-b border-black/10 dark:border-white/15">
          <nav className="mx-auto max-w-5xl flex items-center gap-6 px-4 py-3 text-sm">
            <Link href="/" className="font-semibold flex items-center gap-1.5">
              <span aria-hidden>🍉</span> santi&apos;s list
            </Link>
            <Link href="/" className="text-black/70 dark:text-white/70 hover:underline">
              Listings
            </Link>
            <Link href="/map" className="text-black/70 dark:text-white/70 hover:underline">
              Map
            </Link>
            <Link href="/watches" className="text-black/70 dark:text-white/70 hover:underline">
              Saved Searches
            </Link>
            <Link href="/settings" className="text-black/70 dark:text-white/70 hover:underline">
              Settings
            </Link>
            <span className="ml-auto">
              <CrawlStatusBadge />
            </span>
          </nav>
        </header>
        <div className="border-b border-black/10 dark:border-white/15 bg-black/[.02] dark:bg-white/[.03]">
          <p className="mx-auto max-w-5xl px-4 py-2 text-xs text-black/50 dark:text-white/50">
            Watches Craigslist for new apartment listings that match your saved searches, verifies the
            neighborhood against real map data, and alerts you the moment one posts.
          </p>
        </div>
        <main className="flex-1 mx-auto w-full max-w-5xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
