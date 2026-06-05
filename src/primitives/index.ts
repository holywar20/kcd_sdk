export { KCDPrimitive, DREDGE_MAX, clampDepth, classifyHref } from './KCDPrimitive';
export { LensObject } from './LensObject';
export type { LensLoadOptions } from './LensObject';
export { KCDParseError, KCDValidationError } from './errors';
export { registerType, registerFallback, createByType } from './factory';
export { defaultReader, inferProjectRoot, resolveHref, classifyByPath, DEFAULT_DOC_ROOT } from './io';
export type {
	ArtifactType,
	LinkType,
	LinkEntry,
	PolicyEntry,
	ReaderFn,
	SerializedArtifact,
	WriteMap,
	ArtifactRef,
} from './types';
