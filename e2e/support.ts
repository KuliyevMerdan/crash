import type { CrashClient } from '@crash/client-core';
import type { ServerMessage } from '@crash/protocol';
import { expect, type Browser, type Page } from '@playwright/test';

export type Msg<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;

/** What the `--mode perf` build hangs on `window` (apps/web/src/main.tsx) — absent in production. */
declare global {
  interface Window {
    __crash?: {
      client: CrashClient;
      drawn(): { kind: string; multiplier: number | null } | null;
      reports: Array<
        | { kind: 'manual'; press: { screen: number; predicted: number }; actual: number }
        | { kind: 'auto'; target: number; actual: number }
        | { kind: 'late'; press: { screen: number; predicted: number } }
      >;
    };
    __frames?: Array<[number, number | null]>;
  }
}

/** A player: a fresh browser context — no token, no history — on the game, live. */
export async function player(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  Object.assign(page, { errors });
  await page.goto('/');
  await expect(page.locator('.bar .pill')).toHaveText('live', { timeout: 30_000 });
  return page;
}

export function errorsOf(page: Page): readonly string[] {
  return 'errors' in page && Array.isArray(page.errors) ? page.errors : [];
}

/** Bet through the real panel, as a player would: type a stake, press the button. */
export async function placeBet(page: Page, stake: string): Promise<void> {
  await page.locator('.stepper input').first().fill(stake);
  await page.locator('.action.place:enabled').click();
  await expect(page.locator('.action.cancel')).toBeVisible();
}

/** The controller: a plain socket from the test, the way a developer forces a round (§9). */
export class Controller {
  private readonly heard: ServerMessage[] = [];
  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (e) => {
      if (typeof e.data === 'string') this.heard.push(JSON.parse(e.data));
    });
  }

  static async connect(baseURL: string): Promise<Controller> {
    const socket = new WebSocket(`${baseURL.replace(/^http/, 'ws')}/ws`);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve());
      socket.addEventListener('error', () => reject(new Error('controller socket failed')));
    });
    const controller = new Controller(socket);
    controller.send({ type: 'authenticate', token: null, nick: 'controller' });
    await controller.next((m) => m.type === 'hello');
    return controller;
  }

  send(message: object): void {
    this.socket.send(JSON.stringify(message));
  }

  /** The first message heard (from now on, or already) that matches. */
  async next<T extends ServerMessage>(match: (m: ServerMessage) => m is T, ms?: number): Promise<T>;
  async next(match: (m: ServerMessage) => boolean, ms?: number): Promise<ServerMessage>;
  async next(match: (m: ServerMessage) => boolean, ms = 120_000): Promise<ServerMessage> {
    const end = Date.now() + ms;
    for (;;) {
      const found = this.heard.find(match);
      if (found) return found;
      if (Date.now() > end) throw new Error('the controller never heard it');
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  close(): void {
    this.socket.close();
  }
}
