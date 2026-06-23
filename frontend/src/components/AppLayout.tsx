import type { ReactNode } from 'react';
import { Navbar } from './Navbar';

interface AppLayoutProps {
  children: ReactNode;
}

/** Original app shell — single navbar with wallet connect/disconnect. */
export function AppLayout({ children }: AppLayoutProps) {
  return (
    <>
      <Navbar />
      {children}
    </>
  );
}
