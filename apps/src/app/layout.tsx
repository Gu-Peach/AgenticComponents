import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Agentic Components · 设备工作台",
  description: "工业设备建模、场景搭建与契约动作预览工作台",
  icons: { icon: { url: "/assets/agentic-mark.svg", type: "image/svg+xml" } },
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
