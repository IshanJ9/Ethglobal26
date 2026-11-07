import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, Newsreader } from "next/font/google";
import { Providers } from "@/components/Providers";
import { AppHeader } from "@/components/AppHeader";
import { SpecBanner } from "@/components/SpecBanner";
import { THEME_BOOT_SCRIPT } from "@/lib/themeBoot";
import "./globals.css";

const display = Newsreader({ subsets: ["latin"], weight: ["300", "400"], style: ["normal", "italic"], variable: "--font-display" });
const body = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-body" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "Proofwork",
  description: "Verified work, deterministic scores, human approval, on-chain proof.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <head>
        {/* Applies the saved light/dark choice before first paint (no flash). */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body className="min-h-screen font-sans text-[15px] antialiased">
        <Providers>
          <SpecBanner />
          <AppHeader />
          <main className="mx-auto max-w-6xl px-4 py-8 sm:px-8">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
