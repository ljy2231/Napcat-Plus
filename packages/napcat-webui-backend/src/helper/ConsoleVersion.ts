import { get } from 'node:https';

const RELEASE_API = 'https://api.github.com/repos/ljy2231/Napcat-Plus/releases/latest';
const RELEASE_PAGE = 'https://github.com/ljy2231/Napcat-Plus/releases/tag/';
const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 5_000;
const SUCCESS_CACHE_MS = 60_000;
const FAILURE_CACHE_MS = 15_000;

export type ConsoleVersionResult = {
  currentVersion: string;
  latestVersion: string | null;
  status: 'current' | 'available' | 'unknown';
  releaseUrl?: string;
};

// Git tags may have a leading v. Prereleases are deliberately excluded: this
// endpoint reports formal releases only. Build metadata does not affect order.
function parseStableVersion (value: unknown): { version: string; parts: string[]; } | null {
  if (typeof value !== 'string' || value.length > 256) return null;
  const match = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match) return null;
  return { version: value.startsWith('v') ? value.slice(1) : value, parts: match.slice(1, 4) };
}

function compareVersions (a: string[], b: string[]): number {
  for (let i = 0; i < 3; i++) {
    const left = a[i]!;
    const right = b[i]!;
    if (left.length !== right.length) return left.length > right.length ? 1 : -1;
    if (left !== right) return left > right ? 1 : -1;
  }
  return 0;
}

type Release = { version: string; parts: string[]; tag: string; };

function fetchRelease (): Promise<Release | null> {
  return new Promise((resolve) => {
    let settled = false;
    let size = 0;
    const chunks: Buffer[] = [];
    const finish = (result: Release | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const request = get(RELEASE_API, {
      headers: { 'User-Agent': 'Napcat-Plus-Version-Check', Accept: 'application/vnd.github+json' },
    }, (response) => {
      if (response.statusCode !== 200) {
        response.destroy();
        finish(null);
        return;
      }
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BYTES) {
          response.destroy();
          request.destroy();
          finish(null);
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', () => finish(null));
      response.on('aborted', () => finish(null));
      response.on('close', () => { if (!response.complete) finish(null); });
      response.on('end', () => {
        try {
          const release: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!release || typeof release !== 'object') return finish(null);
          const data = release as Record<string, unknown>;
          const version = parseStableVersion(data['tag_name']);
          if (!version || data['draft'] !== false || data['prerelease'] !== false) return finish(null);
          finish({ ...version, tag: data['tag_name'] as string });
        } catch { finish(null); }
      });
    });
    const timer = setTimeout(() => {
      request.destroy();
      finish(null);
    }, TIMEOUT_MS);
    request.on('error', () => finish(null));
  });
}

// The cache stores only the remote result; comparison always uses the caller's
// current version. No stale successful result is used after a failed refresh.
export function createConsoleVersionChecker () {
  let cached: { release: Release | null; expires: number; } | undefined;
  let inFlight: Promise<Release | null> | undefined;
  return async (currentVersion: string): Promise<ConsoleVersionResult> => {
    const current = parseStableVersion(currentVersion);
    const unknown: ConsoleVersionResult = { currentVersion, latestVersion: null, status: 'unknown' };
    if (!current) return unknown;
    let release: Release | null;
    if (cached && Date.now() < cached.expires) {
      release = cached.release;
    } else {
      inFlight ??= fetchRelease().catch(() => null).then((result) => {
        cached = { release: result, expires: Date.now() + (result ? SUCCESS_CACHE_MS : FAILURE_CACHE_MS) };
        return result;
      }).finally(() => { inFlight = undefined; });
      release = await inFlight;
    }
    if (!release) return unknown;
    const comparison = compareVersions(release.parts, current.parts);
    return {
      currentVersion,
      latestVersion: release.version,
      status: comparison > 0 ? 'available' : comparison === 0 ? 'current' : 'unknown',
      releaseUrl: RELEASE_PAGE + encodeURIComponent(release.tag),
    };
  };
}

// The image sets NAPCAT_PLUS_VERSION at build time so a tagged build cannot keep
// reporting the hard-coded fallback. Invalid or absent values keep the fallback.
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
export function resolveConsoleVersion (value: string | undefined, fallback: string): string {
  return typeof value === 'string' && VERSION_PATTERN.test(value) ? value : fallback;
}

export const checkConsoleVersion = createConsoleVersionChecker();
