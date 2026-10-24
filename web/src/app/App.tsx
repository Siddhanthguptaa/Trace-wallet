import { Component, lazy, Suspense, type ReactNode } from 'react';
import { createBrowserRouter, RouterProvider, Navigate, Link } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig } from 'framer-motion';
import { WalletProvider } from '@/chain/wallet';
import { ApiError } from '@/api/http';
import { Backdrop } from '@/components/Chrome';
import { Loading } from '@/components/ui';

const Landing = lazy(() => import('@/surfaces/landing/Landing'));
const Demo = lazy(() => import('@/surfaces/demo/Demo'));
const ConsoleLayout = lazy(() => import('@/surfaces/console/ConsoleLayout'));
const Overview = lazy(() => import('@/surfaces/console/Overview'));
const PolicyView = lazy(() => import('@/surfaces/console/Policy'));
const Payees = lazy(() => import('@/surfaces/console/Payees'));
const Approvals = lazy(() => import('@/surfaces/console/Approvals'));
const Activity = lazy(() => import('@/surfaces/console/Activity'));
const Keys = lazy(() => import('@/surfaces/console/Keys'));
const Setup = lazy(() => import('@/surfaces/console/Setup'));
const Approve = lazy(() => import('@/surfaces/approve/Approve'));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (n, e) => !(e instanceof ApiError && (e.kind === 'not-configured' || e.kind === 'schema')) && n < 2,
      refetchOnWindowFocus: true,
    },
  },
});

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main style={{ maxWidth: 640, margin: '0 auto', padding: '96px 24px', display: 'grid', gap: 16 }}>
        <h1 style={{ fontSize: 28 }}>This screen hit an error</h1>
        <p style={{ color: 'var(--text-2)' }}>
          Nothing was signed or sent. Reload to try again. If it keeps happening, the message below helps whoever fixes it.
        </p>
        <code style={{ color: 'var(--text-3)', fontSize: 13 }}>{this.state.error.message}</code>
        <p>
          <a href="/">Back to the start</a>
        </p>
      </main>
    );
  }
}

const page = (el: ReactNode) => (
  <Boundary>
    <Suspense fallback={<Loading lines={4} />}>{el}</Suspense>
  </Boundary>
);

function NotFound() {
  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: '96px 24px', display: 'grid', gap: 16 }}>
      <h1 style={{ fontSize: 28 }}>No page here</h1>
      <p style={{ color: 'var(--text-2)' }}>The link may be old. Approval links stop working once used or expired.</p>
      <p>
        <Link to="/">Back to the start</Link>
      </p>
    </main>
  );
}

const router = createBrowserRouter([
  { path: '/', element: page(<Landing />) },
  { path: '/demo', element: page(<Demo />) },
  {
    path: '/console',
    element: page(<ConsoleLayout />),
    children: [
      { index: true, element: page(<Overview />) },
      { path: 'policy', element: page(<PolicyView />) },
      { path: 'payees', element: page(<Payees />) },
      { path: 'approvals', element: page(<Approvals />) },
      { path: 'activity', element: page(<Activity />) },
      { path: 'keys', element: page(<Keys />) },
      { path: 'setup', element: page(<Setup />) },
      { path: '*', element: <Navigate to="/console" replace /> },
    ],
  },
  { path: '/approve/:id', element: page(<Approve />) },
  { path: '*', element: <NotFound /> },
]);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <MotionConfig reducedMotion="user">
      <WalletProvider>
        <Backdrop drift={typeof window !== 'undefined' && window.location.pathname === '/'} />
        <RouterProvider router={router} />
      </WalletProvider>
      </MotionConfig>
    </QueryClientProvider>
  );
}
