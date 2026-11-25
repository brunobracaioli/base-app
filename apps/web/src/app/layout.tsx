import type { Metadata } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Base app',
  description: 'A secure mobile app and API foundation.',
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  await headers();
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
