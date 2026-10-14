/**
 * RoleGroup — an install-level, user-authored named set of tool identities: a ROLE ("Frontend Development",
 * "Outreach", "Research") rather than a tool or a project. Sits beside `ToolAccess`, which holds the per-tool
 * vocabularies (`ToolMode`, `Policy`) a role group is ultimately projected onto — a reader orienting on "what
 * can a tool be set to" finds this right next to the vocabulary it writes through.
 *
 * `tools` is an EXPLICIT LIST of `group.tool` identities, from any package, and never a package reference.
 * An editor may offer "add all of `sm_file`" as one click, but that click resolves to explicit tool ids at
 * author time. A stored package reference would mean a package gaining a tool silently widening every
 * wearer of the role group — a silent widening by convenience, which is the one direction tool access may
 * never move in.
 *
 * MEMBERSHIP IS MANY-TO-MANY, DELIBERATELY: a tool may belong to several role groups at once, and nothing
 * in this codebase refuses that. "Frontend Development" and "Outreach" can both want `sm_file.read` — roles
 * overlap by nature, and a design that refused the overlap could not express a role.
 */
export interface RoleGroup {
	/** Kebab, stable — never renamed in place. What a wearer's membership is keyed on. */
	id: string;
	/** What a person reads on the switch. */
	name: string;
	/** Why this set exists, for the person who inherits it. */
	description?: string;
	/** Explicit `group.tool` identities. See the file comment for why this is a list and never a package reference. */
	tools: string[];
}
