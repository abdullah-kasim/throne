// A fake for the filesystem half of the ServiceUnitDeps seam, shared by every
// test that drives unit rendering/installation (install-services). It records
// writes so idempotence can be proven by an EMPTY write list rather than by
// prose.
//
// Nothing here touches the real filesystem or the real systemctl.

import type { InstalledUnit, ServiceUnitDeps } from '../src/install-services/service-unit-renderer.service.ts';

export interface FakeUnitFs {
  /** Unit sources on disk, keyed by absolute source path. */
  sources: Map<string, string>;
  /** What occupies each installed unit path. */
  installed: Map<string, InstalledUnit>;
  /** Every writeUnitFile call, in order. */
  writes: Array<{ targetPath: string; content: string }>;
  /** Every removeUnitFile call, in order. */
  removals: string[];
  /** The filesystem members of ServiceUnitDeps, plus `removeUnitFile` (InstallServicesDeps-only). */
  deps: Omit<ServiceUnitDeps, 'systemctl'> & { removeUnitFile(targetPath: string): Promise<void> };
}

export interface FakeUnitFsInit {
  sources?: Record<string, string>;
  installed?: Record<string, InstalledUnit>;
}

export function makeFakeUnitFs(init: FakeUnitFsInit = {}): FakeUnitFs {
  const sources = new Map(Object.entries(init.sources ?? {}));
  const installed = new Map(Object.entries(init.installed ?? {}));
  const writes: Array<{ targetPath: string; content: string }> = [];
  const removals: string[] = [];

  return {
    sources,
    installed,
    writes,
    removals,
    deps: {
      readUnitSource: async (sourcePath) => {
        const source = sources.get(sourcePath);
        if (source === undefined) {
          throw new Error(`ENOENT: no such file or directory, open '${sourcePath}'`);
        }
        return source;
      },
      inspectInstalledUnit: async (targetPath) =>
        installed.get(targetPath) ?? { kind: 'missing', content: '' },
      writeUnitFile: async (targetPath, content) => {
        writes.push({ targetPath, content });
        installed.set(targetPath, { kind: 'file', content });
      },
      removeUnitFile: async (targetPath) => {
        removals.push(targetPath);
        installed.delete(targetPath);
      },
    },
  };
}
