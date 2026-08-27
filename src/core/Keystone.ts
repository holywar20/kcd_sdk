/**
 * A KEYSTONE — a first-party tool that is ours end to end.
 *
 * Not a "built-in" in Claude Code's sense, and the distinction is the whole reason this type exists.
 * THEIR built-ins are built into the CHILD: they run outside our process, reach no gate, build no truck
 * and consult no floor — which is exactly what makes them painful, and why the child is spawned with
 * `--tools ""` and holds none. A keystone is the opposite trade. It runs inside OUR perimeter with both
 * ends of the call in our hands, which is what buys the capacity a borrowed tool can never have — driving
 * the desktop, reading the documentation base, narrating a feature live while it happens — and it is
 * governed like everything else. Owning both ends is where the power comes from; escaping the gate is not.
 *
 * The intent is that a keystone pulls core components of the system into itself and runs them. It is the
 * seam where Starmind's own machinery becomes something an agent can call, so the interesting keystones
 * will be compositions of parts that already exist rather than new subsystems.
 *
 * ── IT DESCRIBES ITSELF, WHOLE ──
 * One object answers every question anyone asks of a keystone: what it is called, what it does, what
 * governs it. There is deliberately no KeystoneDisplay beside a KeystoneExecution. Two types describing
 * one thing is two places for them to disagree, and it forces a registry between them whose only job is
 * to reassemble what was split for no reason.
 *
 * `blurb` has TWO readers and is ONE string: the capability deck renders it, and it becomes the tool
 * description the model is handed. Those must never be allowed to drift — a person reading the panel and
 * an agent reading its tool list are entitled to the same sentence.
 *
 * `doc` is the OTHER HALF of that same two-tier bargain, and it is why a tool can be described honestly
 * without the description costing what an honest one would. The blurb is the one-liner every agent
 * carries; the doc is the full account a surface — or an agent — FETCHES when it decides this tool is the
 * one. Every other tool def on the wire already carries both ( `WireToolDef.doc` ), and a keystone that
 * could only carry the one would have to choose between a manifest line nobody can act on and a paragraph
 * every agent pays for whether or not it ever calls the tool.
 *
 * ── WHAT IS DELIBERATELY ABSENT ──
 * No POLICY and no SURFACE. Both are answered elsewhere against this keystone's `group.tool` identity —
 * the run's passport says whether it may be called, the agent's mode map says how much of it loads.
 *
 * No SERVICES list either, and that is the more interesting absence. What a keystone may reach is a
 * property of its PACKAGE ( `subscribes` on the package row ), which is checked against a real service
 * roster at author time and is the same row a person reads before installing. A free-text copy here
 * would be a second declaration nothing validates.
 *
 * THIS IS STILL THE PROTO-OBJECT. The shape will move as keystones are actually built, so it is documented
 * lightly on purpose — a paragraph defending a field that changes next month is worse than no paragraph.
 */

/**
 * Which action gates govern this tool, and where each one's subjects live in its own input. Gate id →
 * property path, or `null` for "this gate applies and there is nothing enumerable to name".
 *
 * The app's `ToolGateDecl` in the same shape, spelled here rather than imported because this package
 * cannot see the app — the same wall the tool-identity separator hit. ONE re-spelling, at the type, so
 * no reader has to invent a second.
 */
export type KeystoneGates = Record<string, string | null>;

export interface SerializedKeystone {
	name:         string;
	blurb:        string;
	group?:       string;
	gates?:       KeystoneGates;
	inputSchema?: Record<string, unknown>;
	doc?:         string;
}

export class Keystone {

	constructor(
		/** The tool name an agent sees. Bare here — the group qualifies it at the wire, so this stays the
		 *  name a person says out loud. */
		readonly name: string,
		/** What it does, in one sentence. Read by a person on the deck AND handed to the model as this
		 *  tool's description. One string, two readers, no translation between them. */
		readonly blurb: string,
		/**
		 * THE PACKAGE IT BELONGS TO — a package id, and a plain string only because this package cannot
		 * see the app's roster to type it against. Main checks it at registration and throws.
		 *
		 * NOT A SERVER. A server is a process boundary somebody else drew. A package is the namespace this
		 * app already installs, stores, and routes by, so a keystone joining one inherits an identity that
		 * is checked at every seam instead of a string an author typed twice.
		 *
		 * Empty means ungrouped, which a surface shows under its own heading rather than hiding.
		 */
		readonly group: string = '',
		/**
		 * Its security declaration — the SAME field every other tool carries, in the same shape, because
		 * from the gate's side this IS every other tool. `{}` is a real answer meaning "genuinely none
		 * apply"; the absence of a declaration is not, and main refuses to serve a tool that omits it.
		 *
		 * There is deliberately no `promoted` flag beside this. A keystone declaring its own gates is what
		 * every first-party tool already does, and the guard against declaring itself somewhere it has not
		 * earned is `validateToolGates` at the serve seam — one authority, not a second boolean.
		 */
		readonly gates: KeystoneGates = {},
		/** What it takes, as JSON Schema — the same shape any other tool publishes, because from an agent's
		 *  side this IS any other tool. */
		readonly inputSchema: Record<string, unknown> = { type: 'object', properties: {} },
		/**
		 * The FULL account, fetched rather than carried. Empty is the honest answer for a tool the blurb
		 * already exhausts, and most are — `glob` takes a path and a pattern and there is nothing further
		 * to say. Write one when the tool has a SCOPE, a refusal an agent has to interpret, or a rule that
		 * is not visible from its schema. Last because it is the field most often left alone.
		 */
		readonly doc: string = ''
	) {}

	serialize(): SerializedKeystone {
		return {
			name: this.name, blurb: this.blurb, group: this.group,
			gates: { ...this.gates }, inputSchema: this.inputSchema, doc: this.doc
		};
	}

	static fromSerialized( json: SerializedKeystone ): Keystone {
		return new Keystone(
			json.name, json.blurb, json.group ?? '', json.gates ?? {},
			json.inputSchema ?? { type: 'object', properties: {} }, json.doc ?? ''
		);
	}
}
