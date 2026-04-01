import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Revision System",
  description: "Personal revision tracker with spaced repetition and realtime sync.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
