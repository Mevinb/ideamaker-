import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "IdeaArena | Local AI group chat",
  description: "A concise local group chat for developing project ideas.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
