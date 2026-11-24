import type { ModuleManifest, TenantContext } from './index.js';

/** Snapshot of enabled modules. An absent tenant configuration must deny access. */
export interface TenantModulesPort {
  getEnabledModuleIds(context: TenantContext): Promise<readonly string[]>;
}
/** Resolution operates only on the selected modules; disabled providers never satisfy requirements. */
export interface ModuleRegistryPort {
  list(): readonly ModuleManifest[];
  get(moduleId: string): ModuleManifest;
  resolve(moduleIds: readonly string[]): readonly ModuleManifest[];
}
export type ModuleRegistryErrorCode = 'INVALID_MANIFEST' | 'DUPLICATE_MODULE' | 'MODULE_NOT_FOUND' | 'MISSING_CAPABILITY' | 'AMBIGUOUS_CAPABILITY' | 'DEPENDENCY_CYCLE';
export class ModuleRegistryError extends Error {
  readonly name = 'ModuleRegistryError';
  constructor(readonly code: ModuleRegistryErrorCode, message: string) { super(message); }
}
