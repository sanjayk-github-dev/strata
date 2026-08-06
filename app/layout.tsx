import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Strata",
  description: "Citation-grade regulatory change intelligence",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
