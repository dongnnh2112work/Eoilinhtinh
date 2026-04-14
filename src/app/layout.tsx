import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Eoilinhtinh',
  description: '3D interactive demo',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        suppressHydrationWarning
        data-new-gr-c-s-check-loaded="14.1282.0"
        data-gr-ext-installed=""
      >
        {children}
      </body>
    </html>
  );
}
