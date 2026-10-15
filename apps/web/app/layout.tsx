import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "ModelGate",
  description: "Receipt extraction routed across vision LLMs with fallback, validation and a budget.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header>
          <Link href="/" className="brand">
            ModelGate
          </Link>
          <nav>
            <Link href="/">Extract</Link>
            <Link href="/usage">Usage</Link>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
