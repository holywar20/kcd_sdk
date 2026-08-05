/**
 * @kcd/core · html — the HTML substrate parser family.
 *
 * Layered: HtmlTree ( reader + navigation ) → KcdAddress ( the data-kcd-* grammar ) → the heads:
 * KcdValidate ( binary conform check ), KcdParse ( object-model emit, in ), KcdEmit ( HTML emit,
 * out — the human audience ), and KcdContext ( AI-audience text emit — the model reads THIS, never
 * raw HTML ). All Node-free; the renderer feeds DOM via HtmlTree.fromDOM, the SDK feeds strings via
 * HtmlTree.parse.
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
export { KcdContext } from './KcdContext';
export { KcdText } from './KcdText';
