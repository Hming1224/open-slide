import { describe, expect, it } from 'vitest';
import { hashArchive, parseDeployJson } from './publish.ts';

describe('publish archive hashing', () => {
  it('is stable regardless of archive entry order', () => {
    const first = {
      'index.html': new TextEncoder().encode('<main>slide</main>'),
      'assets/logo.svg': new TextEncoder().encode('<svg />'),
    };
    const second = {
      'assets/logo.svg': new TextEncoder().encode('<svg />'),
      'index.html': new TextEncoder().encode('<main>slide</main>'),
    };

    expect(hashArchive(first)).toBe(hashArchive(second));
  });

  it('changes when audience output changes', () => {
    const before = { 'index.html': new TextEncoder().encode('<main>before</main>') };
    const after = { 'index.html': new TextEncoder().encode('<main>after</main>') };

    expect(hashArchive(before)).not.toBe(hashArchive(after));
  });

  it('ignores empty directory entries emitted by zip tools', () => {
    const withoutDirectory = { 'index.html': new TextEncoder().encode('<main>slide</main>') };
    const withDirectory = {
      'assets/': new Uint8Array(),
      'index.html': new TextEncoder().encode('<main>slide</main>'),
    };

    expect(hashArchive(withDirectory)).toBe(hashArchive(withoutDirectory));
  });

  it('rejects paths that escape the deployment directory', () => {
    expect(() => hashArchive({ '../secret': new Uint8Array([1]) })).toThrow('unsafe archive path');
  });
});

describe('Vercel deployment output', () => {
  it('reads the nested JSON format after progress output', () => {
    const output = `Retrieving project…\n{\n  "status": "ok",\n  "deployment": {\n    "id": "dpl_123",\n    "url": "https://preview.vercel.app"\n  }\n}`;

    expect(parseDeployJson(output)).toEqual({
      id: 'dpl_123',
      url: 'https://preview.vercel.app',
    });
  });

  it('keeps compatibility with the flat JSON format', () => {
    expect(parseDeployJson('{"id":"dpl_456","url":"preview.vercel.app"}')).toEqual({
      id: 'dpl_456',
      url: 'preview.vercel.app',
    });
  });
});
