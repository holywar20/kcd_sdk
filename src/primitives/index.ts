export * from './framework';
export * from './procedure';
export { KCDParseError, KCDValidationError } from './errors';
export type {
	ArtifactType,
	ContextSegment,
	KCDRole,
	LinkType,
	LinkEntry,
	PolicyEntry,
	ReaderFn,
	SerializedArtifact,
	SerializedLens,
	TypeCheckIssue,
	WriteMap,
	ArtifactRef,
} from './types';

// ── Hydrator dispatch table ──────────────────────────────────────────────────
// Map each type to its subclass's fromSerialized so KCDPrimitive.fromSerialized( json )
// rebuilds the right prototype (real getRole / toContextBlock). Registered here at the
// barrel — the one module that already pulls in every subclass — rather than scattered
// across each file. Types with no entry (unknown) fall back to a base primitive.
import { KCDPrimitive } from './framework/KCDPrimitive';
import { LensObject } from './framework/LensObject';
import { PlanObject } from './framework/PlanObject';
import { IndexObject } from './framework/IndexObject';
import { ReferenceObject } from './framework/ReferenceObject';
import { FrameworkObject } from './framework/FrameworkObject';
import { TemplateObject } from './framework/TemplateObject';
import { HabitObject } from './procedure/HabitObject';
import { ContractObject } from './procedure/ContractObject';
import { GeneratorObject } from './procedure/GeneratorObject';
import { AnalyzerObject } from './procedure/AnalyzerObject';
import { PipelineObject } from './procedure/PipelineObject';
import { UtilityObject } from './procedure/UtilityObject';

KCDPrimitive.registerHydrator( 'lens', LensObject.fromSerialized );
KCDPrimitive.registerHydrator( 'plan', PlanObject.fromSerialized );
// nav-index is the canonical type ( what the HTML `data-kcd` carries ); `index` stays mapped as
// the pre-alignment alias so a stray serialized `index` still hydrates the right prototype.
KCDPrimitive.registerHydrator( 'nav-index', IndexObject.fromSerialized );
KCDPrimitive.registerHydrator( 'index', IndexObject.fromSerialized );
KCDPrimitive.registerHydrator( 'reference', ReferenceObject.fromSerialized );
KCDPrimitive.registerHydrator( 'framework', FrameworkObject.fromSerialized );
KCDPrimitive.registerHydrator( 'template', TemplateObject.fromSerialized );
KCDPrimitive.registerHydrator( 'habit', HabitObject.fromSerialized );
KCDPrimitive.registerHydrator( 'contract', ContractObject.fromSerialized );
KCDPrimitive.registerHydrator( 'generator', GeneratorObject.fromSerialized );
KCDPrimitive.registerHydrator( 'analyzer', AnalyzerObject.fromSerialized );
KCDPrimitive.registerHydrator( 'pipeline', PipelineObject.fromSerialized );
KCDPrimitive.registerHydrator( 'utility', UtilityObject.fromSerialized );
