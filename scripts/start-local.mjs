#!/usr/bin/env node
// First run: install dependencies and download models. Later runs reuse them.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const children = new Set();
let stopping = false;

function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
  }
  // Give the services time to release their ports; then stop any stragglers.
  setTimeout(() => {
    for (const child of children) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
    }
    process.exit(code);
  }, 1500);
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

function launch(command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, env: process.env, stdio: 'inherit', detached: true, ...options });
  children.add(child);
  // Keep the PID until shutdown so descendants are also stopped if a parent exits.
  return child;
}

function run(command, args, options) {
  return new Promise((resolveRun, reject) => {
    const child = launch(command, args, options);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      children.delete(child);
      if (code === 0) resolveRun();
      else reject(new Error(`${command} failed (${signal || code}). See output above.`));
    });
  });
}

async function freePort(port) {
  await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error(`Port ${port} is already in use. Stop the existing server and run npm run local again.`)));
    server.listen(port, '127.0.0.1', () => server.close(resolvePort));
  });
}

async function ready(url, child, label) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (stopping) throw new Error('Startup stopped.');
    if (child.exitCode !== null || child.signalCode) throw new Error(`${label} exited before it was ready. Check .local/logs/.`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      await response.arrayBuffer();
      if (response.ok) return;
    } catch { /* Wait for model loading or compilation. */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
  throw new Error(`${label} did not become ready within 3 minutes. Check .local/logs/.`);
}

async function serve(label, command, args, url, logName) {
  const fd = openSync(join(root, '.local/logs', logName), 'w');
  const child = launch(command, args, { stdio: ['ignore', fd, fd] });
  closeSync(fd);
  child.once('error', (error) => {
    console.error(`${label}: ${error.message}`);
    stop(1);
  });
  child.once('exit', (code, signal) => {
    if (!stopping) {
      console.error(`${label} stopped (${signal || code}). Check .local/logs/${logName}`);
      stop(1);
    }
  });
  await ready(url, child, label);
  console.log(`${label} ready.`);
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('Usage: npm run local\nRequires an Apple Silicon Mac, Node.js 22+, uv, and a running local MongoDB.\nInstalls dependencies, downloads both models, and starts the model servers and app.\nPress Ctrl+C to stop. Logs: .local/logs/');
    return;
  }
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('These MLX models require an Apple Silicon Mac. Run this from a native arm64 terminal.');
  }
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Install Node.js 22 or newer, then try again.');
  for (const command of ['npm', 'uv', 'curl']) {
    if (spawnSync(command, ['--version'], { stdio: 'ignore' }).status !== 0) {
      throw new Error(`Missing ${command}. Install the prerequisites listed in README.md.`);
    }
  }

  if (!existsSync('.env.local')) {
    const template = readFileSync('.env.example', 'utf8');
    writeFileSync('.env.local', template.replace('GENERATED_ON_FIRST_RUN', randomBytes(32).toString('hex')), { mode: 0o600, flag: 'wx' });
    console.log('Created .env.local with a unique local auth secret.');
  }
  process.loadEnvFile('.env.local');

  // The one-command launcher uses the standard local ports. Advanced setups can
  // still use the individual serve commands with their own environment settings.
  const defaults = {
    BETTER_AUTH_URL: 'http://localhost:3000',
    RAG_LOCAL_EMBEDDING_URL: 'http://127.0.0.1:8099/v1/embeddings',
    RAG_LOCAL_CHAT_URL: 'http://127.0.0.1:8098/v1/chat/completions',
    EMBEDDING_HOST: '127.0.0.1', EMBEDDING_PORT: '8099',
    CHAT_HOST: '127.0.0.1', CHAT_PORT: '8098',
  };
  for (const [name, value] of Object.entries(defaults)) {
    if (process.env[name] && process.env[name] !== value) {
      throw new Error(`npm run local expects ${name}=${value}. Update .env.local or use the individual serve commands in README.md.`);
    }
    process.env[name] = value;
  }
  for (const port of [3000, 8098, 8099]) await freePort(port);

  console.log('Installing app dependencies...');
  await run('npm', ['ci']);
  const { MongoClient } = await import('mongodb');
  const mongo = new MongoClient(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/mercor_test', { serverSelectionTimeoutMS: 5000 });
  try {
    await mongo.db().command({ ping: 1 });
  } catch {
    throw new Error('Cannot reach MongoDB. Start MongoDB locally first (see README.md), then run npm run local again. Check MONGODB_URI in .env.local if needed.');
  } finally {
    await mongo.close();
  }

  const services = [
    { dir: 'embeddinggemma', dependency: 'mlx-vlm==0.7.11', model: 'embed' },
    { dir: 'minicpm', dependency: 'mlx-lm==0.32.2', model: 'chat' },
  ];
  for (const service of services) {
    console.log(`Setting up ${service.dir}...`);
    const venv = join(root, 'services', service.dir, '.venv');
    if (!existsSync(join(venv, 'bin/python'))) await run('uv', ['venv', '--python', '3.12', venv]);
    await run('uv', ['pip', 'install', '--python', join(venv, 'bin/python'), service.dependency]);
    // The existing resumable downloader needs Python for JSON parsing. Use the
    // managed environment so a separate system Python installation is unnecessary.
    await run('npm', ['run', `${service.model}:download`], {
      env: { ...process.env, PATH: `${venv}/bin:${process.env.PATH}` },
    });
  }

  mkdirSync('.local/logs', { recursive: true });
  console.log('Starting model servers (first load may take a minute)...');
  await serve('EmbeddingGemma', 'bash', ['services/embeddinggemma/serve.sh'], 'http://127.0.0.1:8099/health', 'embedding.log');
  await serve('MiniCPM', 'bash', ['services/minicpm/serve.sh'], 'http://127.0.0.1:8098/v1/models', 'chat.log');
  await serve('Web app', process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', '3000'], 'http://127.0.0.1:3000', 'web.log');
  console.log('\nOpen http://localhost:3000\nUpload a document and start chatting.\nKeep this terminal open. Press Ctrl+C to stop all three servers.\nLogs: .local/logs/');
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  stop(1);
});
