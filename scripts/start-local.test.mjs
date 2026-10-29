import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mercor local test '));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ports = [await freePort(), await freePort(), await freePort()];
  const remap = (text) => text.replace(/3000|8098|8099/g, (port) => String(ports[['3000', '8098', '8099'].indexOf(port)]));
  const put = async (path, text, mode = 0o644) => {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text, { mode });
  };
  await put('scripts/start-local.mjs', remap(await readFile(join(root, 'scripts/start-local.mjs'), 'utf8')));
  await put('.env.example', remap(await readFile(join(root, '.env.example'), 'utf8')));
  await put('package.json', '{"type":"module"}');
  await put('node_modules/mongodb/package.json', '{"type":"module","exports":"./index.js"}');
  await put('node_modules/mongodb/index.js', 'export class MongoClient { db() { return { command: async () => { if (process.env.MOCK_MONGO_FAIL) throw Error("offline"); } }; } async close() {} }');
  await put('bin/npm', '#!/bin/bash\necho "npm $*" >> calls.log\n', 0o755);
  await put('bin/curl', '#!/bin/bash\nexit 0\n', 0o755);
  await put('bin/uv', '#!/bin/bash\necho "uv $*" >> calls.log\nif [[ "$1" == venv ]]; then mkdir -p "$4/bin"; touch "$4/bin/python"; fi\n', 0o755);
  const server = `import { createServer } from 'node:http';
const server = createServer((req, res) => { res.end('ok'); });
server.listen(Number(process.argv.at(-1)), '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;
  await put('mock-server.mjs', server);
  await put('node_modules/next/dist/bin/next', server);
  await put('services/embeddinggemma/serve.sh', `#!/bin/bash\nexec "${process.execPath}" mock-server.mjs ${ports[2]}\n`);
  await put('services/minicpm/serve.sh', `#!/bin/bash\nexec "${process.execPath}" mock-server.mjs ${ports[1]}\n`);
  function start(extraEnv = {}) {
    const child = spawn(process.execPath, ['scripts/start-local.mjs'], {
      cwd: dir, env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}`, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
    return { child, output: () => output };
  }
  return { dir, ports, start };
}

async function waitForOutput(run, expected) {
  const deadline = Date.now() + 15000;
  while (!run.output().includes(expected)) {
    assert.equal(run.child.exitCode, null, run.output());
    assert.ok(Date.now() < deadline, `Timed out: ${run.output()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const supported = process.platform === 'darwin' && process.arch === 'arm64';
test('local launcher installs, starts, reuses settings, and cleans up', { skip: !supported }, async (t) => {
  const f = await fixture(t);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const run = f.start();
    await waitForOutput(run, 'Press Ctrl+C');
    for (const port of f.ports) assert.equal((await fetch(`http://127.0.0.1:${port}`)).status, 200);
    const env = await readFile(join(f.dir, '.env.local'), 'utf8');
    assert.match(env, /BETTER_AUTH_SECRET=[a-f0-9]{64}/);
    if (attempt === 0) await writeFile(join(f.dir, 'original-env'), env);
    else assert.equal(env, await readFile(join(f.dir, 'original-env'), 'utf8'));
    const exited = once(run.child, 'exit');
    run.child.kill('SIGINT');
    assert.equal((await exited)[0], 0);
    for (const port of f.ports) await assert.rejects(fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) }));
  }
  const calls = await readFile(join(f.dir, 'calls.log'), 'utf8');
  assert.match(calls, /npm ci/);
  assert.match(calls, /npm run embed:download/);
  assert.match(calls, /npm run chat:download/);
  assert.equal((calls.match(/uv venv/g) ?? []).length, 2, 'existing environments should be reused');
});

test('local launcher explains MongoDB failure before model setup', { skip: !supported }, async (t) => {
  const f = await fixture(t);
  const run = f.start({ MOCK_MONGO_FAIL: '1' });
  assert.equal((await once(run.child, 'exit'))[0], 1);
  assert.match(run.output(), /Start MongoDB locally first/);
  const calls = await readFile(join(f.dir, 'calls.log'), 'utf8');
  assert.doesNotMatch(calls, /uv venv|:download/);
});

test('local launcher leaves an occupied port untouched', { skip: !supported }, async (t) => {
  const f = await fixture(t);
  const server = createServer();
  server.listen(f.ports[0], '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const run = f.start();
  assert.equal((await once(run.child, 'exit'))[0], 1);
  assert.match(run.output(), /already in use/);
  assert.ok(server.listening);
  assert.doesNotMatch(await readFile(join(f.dir, 'calls.log'), 'utf8'), /npm ci|uv venv|:download/);
});
