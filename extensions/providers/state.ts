/**
 * Shared provider state — uses globalThis so it works even when
 * the module is loaded multiple times (jiti moduleCache: false).
 */

const KEY = "__cortex_active_provider_account__";

export function getActiveProviderAccount(): string | null {
	return (globalThis as any)[KEY] ?? null;
}

export function setActiveProviderAccount(name: string | null): void {
	(globalThis as any)[KEY] = name;
}
