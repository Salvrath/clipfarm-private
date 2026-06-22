import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "ClipFarm",
  description: "Private short-form clip generator"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
