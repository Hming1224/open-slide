import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import type { Connect, ViteDevServer } from 'vite';
import { SLIDE_ID_RE } from '../../editing/slide-ops.ts';
import { validateMutationRequest } from '../../http/request-guard.ts';
import type {
  PublishResult,
  PublishSettingsInput,
  SlidePublishState,
} from '../../publish/types.ts';
import { type ApiContext, json, readBody } from './context.ts';

// GET   /__publish/:slideId          read publish state
// PATCH /__publish/:slideId          save auto-publish and Vercel target settings
// POST  /__publish/:slideId/dirty    persist a client-observed HMR change
// POST  /__publish/:slideId/deploy   compare and publish an audience HTML archive

const STORE_VERSION = 1;
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const VERCEL_CLI_VERSION = '59.0.0';
const PROJECT_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const TEAM_RE = /^[a-zA-Z0-9_-]{1,128}$/;

type PublishStore = {
  version: number;
  slides: Record<string, SlidePublishState>;
};

type DeployJson = {
  id?: unknown;
  url?: unknown;
  deployment?: {
    id?: unknown;
    url?: unknown;
  };
};

const deployLocks = new Map<string, Promise<PublishResult>>();
let storeWriteQueue: Promise<unknown> = Promise.resolve();

function defaultProjectName(ctx: ApiContext, slideId: string): string {
  const base = `${path.basename(ctx.userCwd)}-${slideId}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
    .replace(/-+$/g, '');
  return base || `open-slide-${slideId}`;
}

function defaultState(ctx: ApiContext, slideId: string): SlidePublishState {
  return {
    slideId,
    autoPublish: false,
    dirty: true,
    dirtyVersion: 0,
    projectName: defaultProjectName(ctx, slideId),
    team: '',
    publicUrl: null,
    previewUrl: null,
    status: 'idle',
    lastCheckedAt: null,
    lastPublishedAt: null,
    lastArtifactHash: null,
    error: null,
  };
}

function storePath(ctx: ApiContext): string {
  return path.join(ctx.userCwd, '.vercel', 'open-slide-publish.json');
}

async function readStore(ctx: ApiContext): Promise<PublishStore> {
  try {
    const raw = JSON.parse(await fs.readFile(storePath(ctx), 'utf8')) as Partial<PublishStore>;
    if (raw.version !== STORE_VERSION || !raw.slides || typeof raw.slides !== 'object') {
      throw new Error('unsupported publish state');
    }
    return { version: STORE_VERSION, slides: raw.slides };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[open-slide] could not read publish state; using defaults', err);
    }
    return { version: STORE_VERSION, slides: {} };
  }
}

async function writeStore(ctx: ApiContext, store: PublishStore): Promise<void> {
  const target = storePath(ctx);
  const temp = `${target}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  await fs.rename(temp, target);
}

async function updateState(
  ctx: ApiContext,
  slideId: string,
  mutate: (state: SlidePublishState) => void,
): Promise<SlidePublishState> {
  const task = storeWriteQueue.then(async () => {
    const store = await readStore(ctx);
    const state = store.slides[slideId] ?? defaultState(ctx, slideId);
    mutate(state);
    store.slides[slideId] = state;
    await writeStore(ctx, store);
    return state;
  });
  storeWriteQueue = task.catch(() => {});
  return await task;
}

async function getState(ctx: ApiContext, slideId: string): Promise<SlidePublishState> {
  const store = await readStore(ctx);
  return store.slides[slideId] ?? defaultState(ctx, slideId);
}

function isValidProjectName(value: string): boolean {
  return PROJECT_NAME_RE.test(value);
}

function isValidTeam(value: string): boolean {
  return value === '' || TEAM_RE.test(value);
}

async function readBinaryBody(req: Connect.IncomingMessage): Promise<Uint8Array> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_ARCHIVE_BYTES) {
        reject(new Error('publish archive is larger than 200 MB'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function isSafeArchivePath(name: string): boolean {
  if (!name || name.includes('\0') || name.startsWith('/') || name.startsWith('\\')) return false;
  const normalized = path.posix.normalize(name.replaceAll('\\', '/'));
  return normalized !== '..' && !normalized.startsWith('../');
}

export function hashArchive(files: Record<string, Uint8Array>): string {
  const hash = createHash('sha256');
  for (const name of Object.keys(files)
    .filter((entry) => !entry.endsWith('/'))
    .sort()) {
    if (!isSafeArchivePath(name)) throw new Error(`unsafe archive path: ${name}`);
    hash.update(name);
    hash.update('\0');
    hash.update(files[name]);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function parseArchive(bytes: Uint8Array): Record<string, Uint8Array> {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error('invalid publish archive');
  }
  const names = Object.keys(files);
  if (names.length === 0 || !names.some((name) => name.toLowerCase().endsWith('.html'))) {
    throw new Error('publish archive does not contain HTML');
  }
  for (const name of names) {
    if (!isSafeArchivePath(name)) throw new Error(`unsafe archive path: ${name}`);
    if (name.endsWith('/')) delete files[name];
  }
  return files;
}

async function materializeArchive(
  files: Record<string, Uint8Array>,
  directory: string,
): Promise<void> {
  const htmlNames = Object.keys(files).filter((name) => name.toLowerCase().endsWith('.html'));
  const entryHtml = htmlNames[0];
  for (const [name, bytes] of Object.entries(files)) {
    if (name.endsWith('/')) continue;
    const relativeName = name === entryHtml ? 'index.html' : name;
    const target = path.join(directory, relativeName);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
  }
}

async function runVercel(args: string[], cwd: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn('npx', ['--yes', `vercel@${VERCEL_CLI_VERSION}`, ...args], {
      cwd,
      env: {
        ...process.env,
        npm_config_cache: path.join(os.tmpdir(), 'open-slide-npx-cache'),
        NO_COLOR: '1',
      },
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Vercel deployment timed out'));
    }, COMMAND_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(stdout.trim());
      reject(new Error(stderr.trim() || stdout.trim() || `Vercel exited with code ${code}`));
    });
  });
}

export function parseDeployJson(output: string): DeployJson {
  const jsonStart = output.indexOf('{');
  const candidates = [
    output,
    jsonStart >= 0 ? output.slice(jsonStart) : '',
    ...output.split('\n').reverse(),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as DeployJson;
      if (typeof parsed.url === 'string') return parsed;
      if (typeof parsed.deployment?.url === 'string') {
        return { id: parsed.deployment.id, url: parsed.deployment.url };
      }
    } catch {}
  }
  throw new Error('Vercel did not return a deployment URL');
}

function withProtocol(value: string): string {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

async function smokeCheck(url: string, cwd: string, team: string): Promise<void> {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
      headers: { 'user-agent': 'open-slide-publisher' },
    });
    const html = response.ok ? await response.text() : '';
    if (html.includes('class="os-stage"')) return;
  } catch {}

  const scopeArgs = team ? ['--scope', team] : [];
  const authenticatedHtml = await runVercel(['curl', url, ...scopeArgs], cwd);
  if (!authenticatedHtml.includes('class="os-stage"')) {
    throw new Error('preview smoke check did not find the slide player');
  }
}

async function deployArchive(
  ctx: ApiContext,
  slideId: string,
  files: Record<string, Uint8Array>,
  artifactHash: string,
): Promise<PublishResult> {
  const before = await getState(ctx, slideId);
  const dirtyVersion = before.dirtyVersion;
  const checkedAt = new Date().toISOString();

  if (before.lastArtifactHash === artifactHash && before.publicUrl) {
    const state = await updateState(ctx, slideId, (current) => {
      current.lastCheckedAt = checkedAt;
      current.error = null;
      current.status = 'live';
      if (current.dirtyVersion === dirtyVersion) current.dirty = false;
    });
    return { state, outcome: 'unchanged' };
  }

  if (!isValidProjectName(before.projectName)) throw new Error('invalid Vercel project name');
  if (!isValidTeam(before.team)) throw new Error('invalid Vercel team');

  await updateState(ctx, slideId, (current) => {
    current.status = 'publishing';
    current.error = null;
    current.lastCheckedAt = checkedAt;
  });

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `open-slide-publish-${slideId}-`));
  try {
    await materializeArchive(files, tempDir);
    const scopeArgs = before.team ? ['--scope', before.team] : [];
    const deployOutput = await runVercel(
      ['deploy', tempDir, '--yes', '--project', before.projectName, '--json', ...scopeArgs],
      ctx.userCwd,
    );
    const deployment = parseDeployJson(deployOutput);
    const previewUrl = withProtocol(deployment.url as string);
    await smokeCheck(previewUrl, ctx.userCwd, before.team);
    await runVercel(['promote', previewUrl, '--yes', ...scopeArgs], ctx.userCwd);

    const publishedAt = new Date().toISOString();
    const publicUrl = `https://${before.projectName}.vercel.app`;
    const state = await updateState(ctx, slideId, (current) => {
      current.previewUrl = previewUrl;
      current.publicUrl = publicUrl;
      current.lastArtifactHash = artifactHash;
      current.lastCheckedAt = publishedAt;
      current.lastPublishedAt = publishedAt;
      current.status = 'live';
      current.error = null;
      if (current.dirtyVersion === dirtyVersion) current.dirty = false;
    });
    return { state, outcome: 'published' };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'publish failed';
    await updateState(ctx, slideId, (current) => {
      current.status = 'failed';
      current.error = message;
      current.dirty = true;
      current.lastCheckedAt = new Date().toISOString();
    });
    throw err;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function markDirty(ctx: ApiContext, slideId: string): Promise<void> {
  const store = await readStore(ctx);
  if (!store.slides[slideId]) return;
  await updateState(ctx, slideId, (state) => {
    state.dirty = true;
    state.dirtyVersion += 1;
    if (state.status !== 'publishing') state.status = state.publicUrl ? 'live' : 'idle';
  });
}

async function markAllConfiguredDirty(ctx: ApiContext): Promise<void> {
  const store = await readStore(ctx);
  await Promise.all(Object.keys(store.slides).map((slideId) => markDirty(ctx, slideId)));
}

function registerDirtyWatcher(server: ViteDevServer, ctx: ApiContext): void {
  const themesRoot = path.join(ctx.userCwd, 'themes');
  server.watcher.add([ctx.slidesRoot, ctx.globalAssetsRoot, themesRoot]);
  const onChange = (changedPath: string) => {
    if (
      changedPath === ctx.globalAssetsRoot ||
      changedPath.startsWith(ctx.globalAssetsRoot + path.sep) ||
      changedPath === themesRoot ||
      changedPath.startsWith(themesRoot + path.sep)
    ) {
      void markAllConfiguredDirty(ctx);
      return;
    }
    if (!changedPath.startsWith(ctx.slidesRoot + path.sep)) return;
    const slideId = changedPath.slice(ctx.slidesRoot.length + 1).split(path.sep)[0];
    if (SLIDE_ID_RE.test(slideId)) void markDirty(ctx, slideId);
  };
  server.watcher.on('add', onChange);
  server.watcher.on('change', onChange);
  server.watcher.on('unlink', onChange);
}

function validateSettings(body: PublishSettingsInput): string | null {
  if (body.projectName !== undefined) {
    if (typeof body.projectName !== 'string' || !isValidProjectName(body.projectName)) {
      return 'project name must use lowercase letters, numbers, and hyphens';
    }
  }
  if (body.team !== undefined && (typeof body.team !== 'string' || !isValidTeam(body.team))) {
    return 'invalid Vercel team';
  }
  if (body.autoPublish !== undefined && typeof body.autoPublish !== 'boolean') {
    return 'autoPublish must be boolean';
  }
  return null;
}

export function registerPublishRoutes(server: ViteDevServer, ctx: ApiContext): void {
  registerDirtyWatcher(server, ctx);
  server.middlewares.use('/__publish', async (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const match = url.pathname.match(/^\/([^/]+)(?:\/(deploy|dirty))?$/);
    if (!match) return next();
    const slideId = match[1];
    const action = match[2] ?? null;
    if (!SLIDE_ID_RE.test(slideId)) return json(res, 400, { error: 'invalid slideId' });
    res.setHeader('cache-control', 'no-store');

    try {
      if ((req.method ?? 'GET') === 'GET' && !action) {
        return json(res, 200, await getState(ctx, slideId));
      }

      if ((req.method ?? 'GET') === 'PATCH' && !action) {
        const guard = validateMutationRequest(req, { requireJsonBody: true });
        if (!guard.ok) return json(res, guard.status, { error: guard.error });
        const body = (await readBody(req)) as PublishSettingsInput;
        const settingsError = validateSettings(body);
        if (settingsError) return json(res, 400, { error: settingsError });
        const state = await updateState(ctx, slideId, (current) => {
          if (body.autoPublish !== undefined) current.autoPublish = body.autoPublish;
          if (body.projectName !== undefined) current.projectName = body.projectName;
          if (body.team !== undefined) current.team = body.team;
        });
        return json(res, 200, state);
      }

      if ((req.method ?? 'GET') === 'POST' && action === 'deploy') {
        const guard = validateMutationRequest(req);
        if (!guard.ok) return json(res, guard.status, { error: guard.error });
        if (deployLocks.has(slideId)) {
          return json(res, 409, { error: 'this slide is already publishing' });
        }
        const archive = await readBinaryBody(req);
        const files = parseArchive(archive);
        const artifactHash = hashArchive(files);
        const task = deployArchive(ctx, slideId, files, artifactHash).finally(() => {
          deployLocks.delete(slideId);
        });
        deployLocks.set(slideId, task);
        return json(res, 200, await task);
      }

      if ((req.method ?? 'GET') === 'POST' && action === 'dirty') {
        const guard = validateMutationRequest(req);
        if (!guard.ok) return json(res, guard.status, { error: guard.error });
        await markDirty(ctx, slideId);
        return json(res, 200, await getState(ctx, slideId));
      }

      next();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'publish failed';
      json(res, 500, { error: message });
    }
  });
}
