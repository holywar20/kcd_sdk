/**
 * TextTypes — the whitelist of extensions read as raw text. Node-free, so both processes and the file MCP can ask
 * "is this text?". Extension-based by ruling: the known-text extension is the gate, never a guess from bytes, and
 * anything not listed reads as binary. To teach the app a new text type, add its extension to `extensions`.
 */
export const TextTypes = {

	/** Lowercase extensions WITHOUT the leading dot. The one place to edit to add a text type. */
	extensions: new Set<string>( [
		// prose / docs
		'txt', 'md', 'markdown', 'mdx', 'rst', 'adoc',
		// data / config
		'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties',
		// line-delimited JSON — plain UTF-8, one JSON object per line. `jsonl` is what every trace channel is
		// written as, so without it the app's own flight recorder is unreadable from a file seat ( DEFECT-342 );
		// `ndjson` is the identical format under its other common name, and omitting it only moves the defect.
		'jsonl', 'ndjson',
		// insight documents — JSON under our own extension ( the SIG / starmind_insight substrate )
		'sig',
		// web / scripts
		'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'vue', 'svelte',
		'html', 'htm', 'xml', 'svg', 'css', 'scss', 'sass', 'less',
		// languages
		'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'php', 'swift', 'lua', 'r', 'pl',
		// godot — scene / resource / script, all plain text in this engine
		'tscn', 'tres', 'gd', 'gdshader',
		// shells
		'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
		// queries / tabular / logs
		'sql', 'graphql', 'gql', 'csv', 'tsv', 'log', 'diff', 'patch',
		// extensionless-as-name (matched whole, see isText)
		'gitignore', 'gitattributes', 'editorconfig', 'dockerfile', 'makefile'
	] ),

	/** The key `isText` actually looks up — the trailing extension, or the bare name for extensionless config
	 *  files (`.gitignore`, `Dockerfile`), lowercased. Exposed so a REFUSAL can name the thing that was
	 *  rejected: "not a known text type" without the key leaves a reader guessing which table to edit, and
	 *  a second parse at the message site would be a second answer to the same question. */
	keyOf( path: string ): string {
		const name = path.replace( /\\/g, '/' ).split( '/' ).pop() ?? ''
		const dot  = name.lastIndexOf( '.' )
		return ( dot > 0 ? name.slice( dot + 1 ) : name.replace( /^\./, '' ) ).toLowerCase()
	},

	/** Is this path a known text type? Reads the trailing extension, or the bare name for
	 *  extensionless config files (`.gitignore`, `Dockerfile`). */
	isText( path: string ): boolean {
		return this.extensions.has( this.keyOf( path ) )
	}
}
