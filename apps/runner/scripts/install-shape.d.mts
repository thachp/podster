// Types for install-shape.mjs, so test/install-shape.test.ts typechecks. It isn't packed.
export type Installed = { name: string; version?: string; dir: string };
export type Lock = { packages: Record<string, { name?: string; dev?: boolean }> };
export const PLATFORM_PREFIX: string;
export function isPlatformBinary(name: string): boolean;
export function hostPlatformPackage(platform?: string, arch?: string, musl?: boolean): string;
export function devOnlyNames(lock: Lock): Set<string>;
export function installedPackages(nodeModules: string): Installed[];
export function bundledNames(paths: string[]): Set<string>;
export function tarballProblems(p: { paths: string[]; devOnly: Set<string> }): string[];
export function folderBytes(dir: string): number;
export function installProblems(p: { packages: { name: string }[]; host: string; supported: string[]; devOnly: Set<string>; bytes: number; budgetBytes: number }): string[];
export function mb(bytes: number): string;
export function childEnv(own?: Record<string, string>, from?: Record<string, string | undefined>): Record<string, string>;
