export * from './framework';
export * from './procedure';
export { KCDParseError, KCDValidationError } from './errors';
export { SLOT_MODES } from './types';
export { POLICIES, TOOL_MODES, holds, carries, policyForMode } from './ToolAccess';
export type { Policy, ToolMode } from './ToolAccess';
export type {
	ArtifactType,
	ContextSegment,
	KCDRole,
	LinkType,
	LinkEntry,
	AddressEntry,
	PolicyEntry,
	ReaderFn,
	SerializedArtifact,
	SerializedLens,
	SlotMode,
	SourceLayer,
	TaggedBlock,
	TypeCheckIssue,
	WriteMap,
	ArtifactRef,
} from './types';

// ── Hydrator dispatch table ──────────────────────────────────────────────────
// Maps each type to its subclass's fromSerialized, so KCDPrimitive.fromSerialized rebuilds the right prototype.
// Kept here, not per file, because this barrel already imports every subclass. Types with no entry fall back to a base primitive.
import { KCDPrimitive } from './framework/KCDPrimitive';
import { LensObject } from './framework/LensObject';
import { PlanObject } from './framework/PlanObject';
import { IndexObject } from './framework/IndexObject';
import { ReferenceObject } from './framework/ReferenceObject';
import { FrameworkObject } from './framework/FrameworkObject';
import { TemplateObject } from './framework/TemplateObject';
import { PromptPartialObject } from './framework/PromptPartialObject';
import { HabitObject } from './procedure/HabitObject';
import { ContractObject } from './procedure/ContractObject';
import { GeneratorObject } from './procedure/GeneratorObject';
import { AnalyzerObject } from './procedure/AnalyzerObject';
import { UtilityObject } from './procedure/UtilityObject';
import { BugReportObject } from './framework/BugReportObject';

KCDPrimitive.registerHydrator( 'lens', LensObject.fromSerialized );
KCDPrimitive.registerHydrator( 'plan', PlanObject.fromSerialized );
// nav-index is the canonical type ( what the HTML `data-kcd` carries ); `index` stays mapped as
// the pre-alignment alias so a stray serialized `index` still hydrates the right prototype.
KCDPrimitive.registerHydrator( 'nav-index', IndexObject.fromSerialized );
KCDPrimitive.registerHydrator( 'index', IndexObject.fromSerialized );
KCDPrimitive.registerHydrator( 'reference', ReferenceObject.fromSerialized );
KCDPrimitive.registerHydrator( 'framework', FrameworkObject.fromSerialized );
KCDPrimitive.registerHydrator( 'template', TemplateObject.fromSerialized );
KCDPrimitive.registerHydrator( 'prompt-partial', PromptPartialObject.fromSerialized );
KCDPrimitive.registerHydrator( 'habit', HabitObject.fromSerialized );
KCDPrimitive.registerHydrator( 'contract', ContractObject.fromSerialized );
KCDPrimitive.registerHydrator( 'generator', GeneratorObject.fromSerialized );
KCDPrimitive.registerHydrator( 'analyzer', AnalyzerObject.fromSerialized );
KCDPrimitive.registerHydrator( 'utility', UtilityObject.fromSerialized );
// No hydrator for `audit`, a retired type: an unregistered type falls back to `hydrateBase`.
KCDPrimitive.registerHydrator( 'bug-report', BugReportObject.fromSerialized );
