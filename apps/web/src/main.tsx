import type { Drawn } from '@crash/renderer';
import type { Report } from './useBetting.js';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Root } from './App.js';
import { createClient } from './client.js';
import './styles.css';

const { client, sendRaw } = createClient();
client.start();

// __ASSERT_CURVE__ (docs/protocol.md §2.6, §9): a tick more than one step off the local curve means
// the two sides disagree about it. Thrown on its own task, so the loud failure never takes the
// client's message handling down with it.
if (__ASSERT_CURVE__) {
  client.subscribe((_state, event) => {
    if (event.type === 'drift') {
      queueMicrotask(() => {
        throw new Error(
          `__ASSERT_CURVE__: tick says ${event.received}, the local curve says ${event.expected}`,
        );
      });
    }
  });
}

// Dev hooks for the perf probe and the E2E suite — stripped from a production build.
let lastDrawn: Drawn | null = null;
const reports: Report[] = [];
if (__DEV_HOOKS__) {
  Object.assign(window, { __crash: { client, drawn: () => lastDrawn, sendRaw, reports } });
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Root
        client={client}
        {...(__DEV_HOOKS__
          ? {
              onDrawn: (d: Drawn) => void (lastDrawn = d),
              onReport: (r: Report) => void reports.push(r),
            }
          : {})}
      />
    </StrictMode>,
  );
}
