import {
  HARNESS_EXECUTABLE_NAMES,
  isCodexNpmWrapperProcess,
  runtimeHarness,
  type Harness,
} from '../harness-routing/harness.ts';
import type { HerdrForegroundProcess, HerdrPaneProcessInfo } from './herdr-inventory.service.ts';

const ALL_HARNESS_EXECUTABLE_NAMES = new Set(Object.values(HARNESS_EXECUTABLE_NAMES).flat());
const HARNESS_INTERPRETER_NAMES = new Set(['bash', 'bun', 'env', 'fish', 'node', 'python', 'python3', 'sh', 'zsh']);
const EXTERNAL_INTERACTIVE_EXECUTABLES = new Set([
  'emacs', 'emacsclient', 'helix', 'hx', 'less', 'man', 'micro', 'more',
  'nano', 'nvim', 'vi', 'vim',
]);

export function executableName(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

export function argvExecutableCandidates(argv: readonly string[]): string[] {
  const executable = executableName(argv[0] ?? '');
  if (!HARNESS_INTERPRETER_NAMES.has(executable)) return [executable];
  return [executable, ...argv.slice(1, 5)
    .filter((arg) => !arg.startsWith('-') && !arg.includes('='))
    .map(executableName)];
}

export function isLiveHarnessProcess(processInfo: HerdrForegroundProcess): boolean {
  if (isCodexNpmWrapperProcess(processInfo)) return true;
  if (ALL_HARNESS_EXECUTABLE_NAMES.has(executableName(processInfo.name))) return true;
  return argvExecutableCandidates(processInfo.argv).some((name) => ALL_HARNESS_EXECUTABLE_NAMES.has(name));
}

export function isRegisteredHarnessProcess(registeredHarness: Harness, processInfo: HerdrForegroundProcess): boolean {
  return [registeredHarness, runtimeHarness(registeredHarness)].some((harness) => {
    const executableNames = new Set(HARNESS_EXECUTABLE_NAMES[harness]);
    return (harness === 'codex' && isCodexNpmWrapperProcess(processInfo)) ||
      executableNames.has(executableName(processInfo.name)) ||
      argvExecutableCandidates(processInfo.argv).some((name) => executableNames.has(name));
  });
}

export function paneHasRegisteredHarnessProcessChain(registeredHarness: Harness, processInfo: HerdrPaneProcessInfo): boolean {
  const hasExact = (harness: Harness): boolean => {
    const names = new Set(HARNESS_EXECUTABLE_NAMES[harness]);
    return processInfo.foregroundProcesses.some((process) =>
      (harness === 'codex' && isCodexNpmWrapperProcess(process)) ||
      names.has(executableName(process.name)) ||
      argvExecutableCandidates(process.argv).some((name) => names.has(name)));
  };
  return hasExact(registeredHarness) && hasExact(runtimeHarness(registeredHarness));
}

export function paneHasLiveHarnessProcess(processInfo: HerdrPaneProcessInfo): boolean {
  return processInfo.foregroundProcesses.some(isLiveHarnessProcess);
}

export function paneHasExternalInteractiveProcess(processInfo: HerdrPaneProcessInfo): boolean {
  return processInfo.foregroundProcesses.some((process) =>
    [process.name, process.argv[0] ?? ''].map(executableName)
      .some((name) => EXTERNAL_INTERACTIVE_EXECUTABLES.has(name)));
}
