// Simulates a compiled `dist/` caught mid-rebuild: importing this module
// fails before any of its exports become usable, mirroring a partial-build
// export mismatch (e.g. a rebuilt module whose consumer still expects a
// stale shape). Used to prove the CLI entrypoint's module-load failure path
// without touching real production sources.
throw new Error('simulated build skew: export mismatch after partial rebuild');

export const executeCommand = (): Promise<number> => Promise.resolve(0);
