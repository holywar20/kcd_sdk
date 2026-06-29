/**
 * TextTypes — the whitelist of file extensions read as raw text (for preview / future context
 * injection). ONE named list, easy to extend: add an extension here and every text-aware surface
 * gains it at once — the main file service's read gate and the renderer browser's preview/inject
 * affordance. Node-free core: both processes (and the file MCP) ask "is this text?".
 *
 * Extension-based by ruling: a known-text extension is the gate (don't guess from bytes alone).
 * Anything not listed reads as binary → not returned as text. To teach the app a new text type, add
 * its extension to `extensions` — that's the whole ritual.
 */
export const TextTypes = {

	/** Lowercase extensions WITHOUT the leading dot. The one place to edit to add a text type. */
	extensions: new Set<string>( [
		// prose / docs
		'txt', 'md', 'markdown', 'mdx', 'rst', 'adoc',
		// data / config
		'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties',
		// insight documents — JSON under our own extension ( the SIG / starmind_insight substrate )
		'sig',
		// web / scripts
		'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'vue', 'svelte',
		'html', 'htm', 'xml', 'svg', 'css', 'scss', 'sass', 'less',
		// languages
		'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'php', 'swift', 'lua', 'r', 'pl',
		// shells
		'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
		// queries / tabular / logs
		'sql', 'graphql', 'gql', 'csv', 'tsv', 'log', 'diff', 'patch',
		// extensionless-as-name (matched whole, see isText)
		'gitignore', 'gitattributes', 'editorconfig', 'dockerfile', 'makefile'
	] ),

	/** Is this path a known text type? Reads the trailing extension, or the bare name for
	 *  extensionless config files (`.gitignore`, `Dockerfile`). */
	isText( path: string ): boolean {
		const name = path.replace( /\\/g, '/' ).split( '/' ).pop() ?? ''
		const dot  = name.lastIndexOf( '.' )
		// dot at 0 (`.gitignore`) or absent (`Dockerfile`) → test the whole name; else the extension.
		const key  = dot > 0 ? name.slice( dot + 1 ) : name.replace( /^\./, '' )
		return this.extensions.has( key.toLowerCase() )
	}
}
