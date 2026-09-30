// The stack the browser scripts measure: a development server, the `--mode perf` build of the web
// app behind `vite preview`, and a controller socket that can force rounds and watch the broadcast.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(here, '../../..');

export async function until(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {}
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export async function startStack({ serverPort, webPort, serverEnv = {} }) {
  const children = [];
  const run = (args, env) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: 'ignore',
    });
    children.push(child);
  };
  const stop = () => children.forEach((c) => c.kill('SIGTERM'));
  process.on('exit', stop);

  run(['apps/server/dist/main.js'], {
    PORT: String(serverPort),
    CRASH_ENV: 'development',
    LOG_LEVEL: 'warn',
    ...serverEnv,
  });
  run(
    [
      'apps/web/node_modules/vite/bin/vite.js',
      'preview',
      'apps/web',
      '--outDir',
      'dist-perf',
      '--host',
      '127.0.0.1',
      '--port',
      String(webPort),
      '--strictPort',
    ],
    {
      CRASH_SERVER: `http://127.0.0.1:${serverPort}`,
    },
  );
  await until(
    () => fetch(`http://127.0.0.1:${serverPort}/ready`).then((r) => r.ok),
    20_000,
    'the server',
  );
  await until(
    () => fetch(`http://127.0.0.1:${webPort}/`).then((r) => r.ok),
    20_000,
    'the web preview',
  );

  const control = new WebSocket(`ws://127.0.0.1:${serverPort}/ws`);
  const heard = [];
  control.addEventListener('message', (e) => heard.push(JSON.parse(e.data)));
  await until(() => control.readyState === 1, 5000, 'the controller socket');
  control.send(JSON.stringify({ type: 'authenticate', token: null, nick: 'controller' }));
  await until(() => heard.some((m) => m.type === 'hello'), 5000, 'hello');

  return {
    webUrl: `http://127.0.0.1:${webPort}/`,
    control,
    heard,
    stop() {
      control.close();
      stop();
    },
  };
}
