/**
 * @kcd/core · html — the HTML substrate parser family: HtmlTree → KcdAddress → the heads.
 * All Node-free: the renderer feeds DOM via `HtmlTree.fromDOM`, the SDK feeds strings via `HtmlTree.parse`.
 * The model reads KcdContext's text, never raw HTML.
 */

export { HtmlTree } from './HtmlTree';
export type { HtmlNode, HtmlEl, HtmlText } from './HtmlTree';
export { KcdAddress } from './KcdAddress';
export type { FieldValidator } from './KcdAddress';
export { KcdValidate } from './KcdValidate';
export type { ValidateReport, ValidateIssue } from './KcdValidate';
export { KcdShapes, SHAPES } from './KcdShapes';
export type { TypeShape, RegionSpec, SectionSpec, SectionTier, ShapeAudit } from './KcdShapes';
export { KcdSynth } from './KcdSynth';
export type { SynthInput, SynthResult, SynthSlots, SynthRow } from './KcdSynth';
export { KcdParse } from './KcdParse';
export type { ParsedArtifact, ParsedSlot, ParsedParam } from './KcdParse';
export { KcdEmit } from './KcdEmit';
export { KcdExcise } from './KcdExcise';
export { KcdEdit } from './KcdEdit';
export { LensMigration } from './LensMigration';
export { KcdContext } from './KcdContext';
/** The what/where/why row — the context system's public row currency. `Agent.bindEnv` takes it in a
 *  public signature and the dispatch tier authors them, so it has to be nameable from outside. */
export type { SlotRow, LeanArtifact } from './KcdContext';
export { KcdText } from './KcdText';
