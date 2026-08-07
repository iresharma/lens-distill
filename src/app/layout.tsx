import type { Metadata } from "next";
import { IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";
import "./globals.css";

const sans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "Lens Distill — persona-driven book claims",
  description:
    "Upload a PDF and an extract.md persona. Watch a real distill pipeline turn a book into cited claims, concepts, and a concept graph.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body className="antialiased">
        <header className="border-b border-white/[0.06]">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3.5">
            <Link
              href="/"
              className="flex items-center gap-2.5 text-sm font-semibold tracking-tight text-white"
            >
              <BrandMark size={26} />
              <span>
                Lens{" "}
                <span className="bg-gradient-to-r from-violet-300 to-teal-300 bg-clip-text text-transparent">
                  Distill
                </span>
              </span>
            </Link>
            <nav className="flex items-center gap-5 text-[12px] text-white/45">
              <a href="/#gallery" className="hover:text-teal-200/90">
                Gallery
              </a>
              <a href="/#upload" className="hover:text-violet-200/90">
                Upload
              </a>
              <span className="hidden items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[10px] uppercase tracking-wider text-white/40 sm:inline-flex">
                <span className="h-1.5 w-1.5 rounded-full bg-teal-400/80" />
                Portfolio
              </span>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-5 py-10 pb-20">{children}</main>
      </body>
    </html>
  );
}
