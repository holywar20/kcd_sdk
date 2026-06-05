import type { ArtifactType } from './types';
import type { KCDPrimitive } from './KCDPrimitive';

/**
 * Type-keyed object factory. Subclasses register themselves at module load;
 * the base class calls createByType() during dredge to build typed children
 * without importing its own subclasses (which would be a circular dependency).
 *
 * The `import type` above is erased at runtime — no actual import cycle exists.
 */

export type FactoryFn = (markdown: string, absPath: string, type: ArtifactType) => KCDPrimitive;

const factories = new Map<ArtifactType, FactoryFn>();
let fallback: FactoryFn | null = null;

/** Register the constructor for a specific artifact type. */
export function registerType(type: ArtifactType, fn: FactoryFn): void {
	factories.set(type, fn);
}

/** Register the constructor used for any type without a specific registration. */
export function registerFallback(fn: FactoryFn): void {
	fallback = fn;
}

/** Build a typed object from raw markdown. Falls back to the base primitive when unregistered. */
export function createByType(type: ArtifactType, markdown: string, absPath: string): KCDPrimitive {
	const fn = factories.get(type) ?? fallback;
	if (!fn) {
		throw new Error(`No factory registered for type "${type}" and no fallback set`);
	}
	return fn(markdown, absPath, type);
}
