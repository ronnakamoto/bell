import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'BELL — Discovery & Pricing',
  description: 'Read-only session catalogue and honest quote display.',
};

export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <html lang="en">
      <body>
        <header>
          <h1>BELL</h1>
          <p>Discovery and pricing only — no trading in this build.</p>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
