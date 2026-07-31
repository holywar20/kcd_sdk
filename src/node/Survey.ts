import * as fs   from 'fs';
import * as path from 'path';

/** One detected language within a component. Counts rank it; they are not an audit. */
export interface SurveyLanguage {
	language: string;
	files:    number;
}

/** A plausible entry point — declared by a manifest, or matched by convention. */
export interface SurveyEntryPoint {
	path:   string;                 // component-relative, forward slashes
	source: 'manifest' | 'convention';
	note?:  string;                 // the manifest field it came from
}

/** Where tests live and how they are named — a shape, not a count of assertions. */
export interface SurveyTests {
	present:     boolean;
	files:       number;
	directories: string[];
	patterns:    string[];          // only conventions actually observed
}

/**
 * What a component is, by the coarsest honest reading of its manifest and location. Deliberately
 * few and deliberately fallible — `unknown` is a legitimate, common answer and reads better than a
 * confident wrong one.
 */
export type ComponentKind = 'application' | 'library' | 'plugin' | 'tool' | 'docs' | 'unknown';

/**
 * One component — a repository, package, or sub-project. THE unit of this survey.
 *
 * Everything a reader needs about a component is HERE, not spread across sibling arrays to be
 * re-joined by path prefix. That join is deterministic, so code does it once rather than asking a
 * model to do it every time ( the lost-in-distance failure mode ).
 */
export interface SurveyComponent {
	id:          string;            // short, stable, filename-safe
	kind:        ComponentKind;
	path:        string;            // root-relative, '.' for the root itself
	name?:       string;            // from the manifest, when it parsed
	version?:    string;
	ecosystem?:  string;            // npm | python | go | rust | dotnet | java | ruby | php
	manifest?:   string;            // root-relative path to the manifest that marks this component
	description: string;            // a mechanical sentence — the prototype a human or agent rewrites
	languages:   SurveyLanguage[];
	entryPoints: SurveyEntryPoint[];
	tests:       SurveyTests;
	contains:    string[];          // ids of components nested directly beneath this one
	stats:       { files: number; bytes: number };
}

/** The whole survey, in memory. `Survey.write` flushes it to a shallow tree of JSON files. */
export interface SurveyReport {
	schema:       string;           // 'survey/1'
	generated:    string;           // ISO
	root:         string;
	components:   SurveyComponent[];
	totals:       { components: number; files: number; bytes: number };
	capabilities: { tsScan: boolean };
	limits:       { maxFiles: number; truncated: boolean };
}

/** Never walked. Build output and vendor trees describe the toolchain, not the project. */
/** The vault folder name, skipped by default — a survey is of the project BESIDE the vault. Its own
 *  literal rather than an import of LensObject: Survey is otherwise dependency-free over fs+path. */
const DEFAULT_DOC_ROOT = '_Claude';

const SKIP_DIRS = new Set( [
	'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'target', 'bin', 'obj',
	'.next', '.nuxt', '.venv', 'venv', '__pycache__', '.tox', '.gradle', '.idea', '.vscode',
	'vendor', 'coverage', '.pytest_cache', '.mypy_cache', 'Pods', 'DerivedData',
] );

/** Extension → language. The census floor: no parsing, just naming what is there. */
const LANGUAGES: Record<string, string> = {
	'.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
	'.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
	'.vue': 'Vue', '.svelte': 'Svelte',
	'.py': 'Python', '.pyi': 'Python',
	'.go': 'Go', '.rs': 'Rust',
	'.cs': 'C#', '.fs': 'F#', '.vb': 'Visual Basic',
	'.java': 'Java', '.kt': 'Kotlin', '.kts': 'Kotlin', '.scala': 'Scala', '.groovy': 'Groovy',
	'.rb': 'Ruby', '.php': 'PHP', '.pl': 'Perl',
	'.c': 'C', '.h': 'C', '.cpp': 'C++', '.cc': 'C++', '.cxx': 'C++', '.hpp': 'C++',
	'.m': 'Objective-C', '.mm': 'Objective-C++', '.swift': 'Swift',
	'.sh': 'Shell', '.bash': 'Shell', '.zsh': 'Shell', '.ps1': 'PowerShell',
	'.sql': 'SQL', '.r': 'R', '.lua': 'Lua', '.dart': 'Dart', '.ex': 'Elixir', '.exs': 'Elixir',
	'.html': 'HTML', '.css': 'CSS', '.scss': 'Sass', '.less': 'Less', '.md': 'Markdown',
};

/** Manifest filename → ecosystem. Presence alone marks a component boundary. */
const MANIFESTS: Record<string, string> = {
	'package.json': 'npm', 'deno.json': 'deno',
	'requirements.txt': 'python', 'pyproject.toml': 'python', 'setup.py': 'python', 'Pipfile': 'python',
	'go.mod': 'go', 'Cargo.toml': 'rust',
	'pom.xml': 'java', 'build.gradle': 'java', 'build.gradle.kts': 'java',
	'Gemfile': 'ruby', 'composer.json': 'php', 'pubspec.yaml': 'dart', 'mix.exs': 'elixir',
	'*.csproj': 'dotnet',
};

/** Entry points by convention, checked relative to each component root. */
const CONVENTIONAL_ENTRIES = [
	'src/index.ts', 'src/index.js', 'src/main.ts', 'src/main.js', 'index.ts', 'index.js',
	'src/main.py', 'main.py', '__main__.py', 'app.py', 'manage.py',
	'main.go', 'cmd/main.go', 'src/main.rs', 'src/lib.rs',
	'Program.cs', 'src/Program.cs', 'main.swift',
];

/**
 * Declaring one of these is positive evidence a component is an APPLICATION rather than a library.
 * A `main` field cannot tell them apart — an Electron app and a published library both have one —
 * so the framework it depends on is the honest signal. Absence proves nothing; it just means we fall
 * back to the weaker reading.
 */
const APP_FRAMEWORKS = [
	'electron', 'next', 'nuxt', '@angular/core', 'react-scripts',
	'express', 'fastify', '@nestjs/core', 'django', 'flask',
];

const TEST_DIRS = new Set( [ '__tests__', 'test', 'tests', 'spec', 'specs', 'testing', 'e2e' ] );

const TEST_PATTERNS: { pattern: string; test: ( f: string ) => boolean }[] = [
	{ pattern: '*.test.*',   test: f => /\.test\.[a-z]+$/i.test( f ) },
	{ pattern: '*.spec.*',   test: f => /\.spec\.[a-z]+$/i.test( f ) },
	{ pattern: '*_test.go',  test: f => /_test\.go$/i.test( f ) },
	{ pattern: 'test_*.py',  test: f => /^test_.+\.py$/i.test( f ) },
	{ pattern: '*_test.py',  test: f => /_test\.py$/i.test( f ) },
	{ pattern: '*Test.java', test: f => /Test\.java$/.test( f ) },
	{ pattern: '*Tests.cs',  test: f => /Tests?\.cs$/.test( f ) },
];

/** Caps. A survey is an orientation aid, not an index — a partial answer beats a huge one. */
const MAX_FILES        = 60_000;
const MAX_COMPONENTS   = 64;
const MAX_LANGUAGES    = 10;
const MAX_ENTRY_POINTS = 8;
const MAX_TEST_DIRS    = 8;

/** Reserved because the written tree uses it for the roster. */
const INDEX_FILE = 'index.json';

interface RawFile { rel: string; size: number; inTestDir: boolean; base: string }

/**
 * Survey — the deterministic reconnaissance pass over a project the vault will sit beside.
 *
 * A CENSUS, not a parse. It names components, languages, entry points and test layout by walking the
 * tree and reading filenames, so it produces a real answer on a Python, Go or C# repository where a
 * TypeScript-only import scan produces nothing at all. The first thing a new user sees has to be
 * about THEIR code, and most code is not TypeScript.
 *
 * The unit is the COMPONENT — the root, plus every directory carrying its own manifest. Each file is
 * attributed to the DEEPEST component containing it, so a monorepo reads as its real parts instead of
 * one averaged blur. Everything about a component is co-located on it; nothing needs re-joining by
 * path prefix, because that join is deterministic and belongs in code.
 *
 * EXPERIMENTAL. This is a prototype for document architecture — a temporary artifact that flushes and
 * refills. Whether a non-frontier agent can actually orient from it, cold and without the reasoning
 * that produced it, is an open question this exists to answer.
 */
export class Survey {

	/**
	 * Walk `projectRoot` and produce the report. Never throws on odd trees.
	 *
	 * The vault is EXCLUDED. A survey reconnoitres the project the vault sits beside, so counting the
	 * vault's own artifacts as the user's code is not a rounding error — it is the wrong answer to the
	 * only question this asks. Left unskipped, a freshly installed vault ( ~44 framework documents )
	 * swamps a small project entirely, and every agent reading the roster concludes the project is
	 * made of KCD HTML. Found 2026-07-25, when a 6-file test project surveyed as 50 files.
	 *
	 * The AGENT SCAFFOLDING is excluded too, by the same argument, via `skipPaths` — the host entry files
	 * and the MCP registration file are configuration for the agent, not substance of the project. The
	 * caller supplies the list ( `VaultUtilities.installedPaths` derives it from the §10 seed declarations )
	 * rather than this module naming those files, which keeps Survey dependency-free over fs+path and keeps
	 * one authority for "what did the install write". Found 2026-07-29: a 26-file corpus surveyed as 30, and
	 * those four files were enough to flip the root component's kind from `unknown` to `docs` — a database
	 * and ops folder reported as documentation, on the strength of three Markdown files the installer had
	 * written seconds earlier. That roster is the walkthrough's entire evidence base.
	 */
	static run( projectRoot: string, opts?: { maxFiles?: number; docRoot?: string; skipPaths?: string[] } ): SurveyReport {
		const root     = path.resolve( projectRoot );
		const maxFiles = opts?.maxFiles ?? MAX_FILES;
		const docRoot  = opts?.docRoot ?? DEFAULT_DOC_ROOT;
		// Normalised to '/' on the way in, because the walk's `rel()` already emits that form — comparing a
		// caller's OS-native path against a '/'-joined one silently matches nothing, which would look exactly
		// like the option working.
		const skipPaths = new Set( ( opts?.skipPaths ?? [] ).map( p => p.replace( /\\/g, '/' ) ) );

		const files:     RawFile[] = [];
		const manifests: { dir: string; file: string; ecosystem: string }[] = [];
		let directories = 0, truncated = false;

		const rel = ( abs: string ): string => path.relative( root, abs ).split( path.sep ).join( '/' );

		const walk = ( dir: string, inTestDir: boolean ): void => {
			let entries: fs.Dirent[];
			try { entries = fs.readdirSync( dir, { withFileTypes: true } ); } catch { return; }

			for ( const entry of entries ) {
				if ( files.length >= maxFiles ) { truncated = true; return; }
				const abs = path.join( dir, entry.name );

				if ( entry.isDirectory() ) {
					if ( SKIP_DIRS.has( entry.name ) || entry.name === docRoot || entry.name.startsWith( '.' ) ) continue;
					directories++;
					const isTest = TEST_DIRS.has( entry.name.toLowerCase() );
					walk( abs, inTestDir || isTest );
					continue;
				}
				if ( !entry.isFile() ) continue;

				// Exact root-relative match, deliberately — a `CLAUDE.md` genuinely nested in a subtree is the
				// project's own file and stays counted. Only what the install writes at the root drops out.
				const relPath = rel( abs );
				if ( skipPaths.has( relPath ) ) continue;

				let size = 0;
				try { size = fs.statSync( abs ).size; } catch { /* unreadable — count it, size 0 */ }
				files.push( { rel: relPath, size, inTestDir, base: entry.name } );

				const eco = MANIFESTS[ entry.name ] ?? ( entry.name.endsWith( '.csproj' ) ? 'dotnet' : undefined );
				if ( eco ) manifests.push( { dir: rel( path.dirname( abs ) ), file: rel( abs ), ecosystem: eco } );
			}
		};

		walk( root, false );

		const components = Survey._components( root, files, manifests );

		return {
			schema:       'survey/1',
			generated:    new Date().toISOString(),
			root:         root.split( path.sep ).join( '/' ),
			components,
			totals: {
				components: components.length,
				files:      files.length,
				bytes:      files.reduce( ( n, f ) => n + f.size, 0 ),
			},
			capabilities: { tsScan: fs.existsSync( path.join( root, 'tsconfig.json' ) ) },
			limits:       { maxFiles, truncated },
		};
	}

	/**
	 * Flush and fill `outDir` with the survey tree: a roster at `index.json` plus one file per
	 * component, FLAT beside it. Deliberately shallow — an agent should be able to list one directory
	 * and see every component, then open exactly the one it needs.
	 *
	 * Destructive by design. The survey is a derived, temporary artifact; a stale component file left
	 * behind after a rename would be worse than no file at all, so the directory is emptied first.
	 * Refuses to flush anything that does not look like a survey directory.
	 */
	static write( report: SurveyReport, outDir: string ): string[] {
		const dir = path.resolve( outDir );

		if ( fs.existsSync( dir ) ) {
			const stray = fs.readdirSync( dir ).filter( f => !f.endsWith( '.json' ) );
			if ( stray.length ) throw new Error( `refusing to flush ${ dir }: it holds non-survey files ( ${ stray.slice( 0, 3 ).join( ', ' ) } )` );
			for ( const f of fs.readdirSync( dir ) ) fs.rmSync( path.join( dir, f ), { force: true } );
		} else {
			fs.mkdirSync( dir, { recursive: true } );
		}

		const written: string[] = [];
		const emit = ( name: string, data: unknown ): void => {
			fs.writeFileSync( path.join( dir, name ), JSON.stringify( data, null, '\t' ) + '\n' );
			written.push( name );
		};

		// The roster names every component and the file that describes it — the one hop an agent makes.
		emit( INDEX_FILE, {
			schema:       report.schema,
			generated:    report.generated,
			root:         report.root,
			totals:       report.totals,
			capabilities: report.capabilities,
			limits:       report.limits,
			components:   report.components.map( c => ( {
				id: c.id, kind: c.kind, path: c.path, file: `${ c.id }.json`, description: c.description,
			} ) ),
		} );

		for ( const c of report.components ) emit( `${ c.id }.json`, { schema: report.schema, ...c } );
		return written;
	}

	/**
	 * The lean text projection — what an agent actually READS.
	 *
	 * Raw JSON is the right thing to store and a poor thing to prompt with: repeated keys and
	 * punctuation cost roughly 1.5–2× the tokens of an equivalent outline, and small models score
	 * worse retrieving from it. So the stored tree stays JSON and this is served instead. `stats`
	 * drops whole — the same partition `layout` gets in an insight document.
	 */
	static project( report: SurveyReport ): string {
		const out: string[] = [];
		out.push( `# survey · ${ report.root } · ${ report.totals.components } components` );
		if ( report.limits.truncated ) out.push( `PARTIAL: walk stopped at ${ report.limits.maxFiles } files — treat absences as unknown, not absent.` );
		out.push( '' );

		for ( const c of report.components ) {
			out.push( `## ${ c.id } · ${ c.kind }${ c.ecosystem ? ` · ${ c.ecosystem }` : '' }` );
			out.push( `path        ${ c.path }` );
			out.push( `about       ${ c.description }` );
			if ( c.languages.length )   out.push( `languages   ${ c.languages.map( l => `${ l.language }(${ l.files })` ).join( ', ' ) }` );
			if ( c.entryPoints.length ) out.push( `entry       ${ c.entryPoints.map( e => e.path ).join( ', ' ) }` );
			out.push( `tests       ${ c.tests.present ? `${ c.tests.files } files · ${ c.tests.patterns.join( ' ' ) || 'by directory' }` : 'none found' }` );
			if ( c.contains.length )    out.push( `contains    ${ c.contains.join( ', ' ) }` );
			out.push( '' );
		}
		return out.join( '\n' );
	}

	// ── Internals ─────────────────────────────────────────────────────────────

	/** Build the component set, attributing every file to the deepest component that contains it. */
	private static _components(
		root: string,
		files: RawFile[],
		manifests: { dir: string; file: string; ecosystem: string }[],
	): SurveyComponent[] {
		// Component roots: '.' always, plus each manifest-bearing directory ( first manifest wins ).
		const roots = new Map<string, { ecosystem: string; manifest: string }>();
		for ( const m of manifests ) {
			const key = m.dir === '' ? '.' : m.dir;
			if ( !roots.has( key ) ) roots.set( key, { ecosystem: m.ecosystem, manifest: m.file } );
		}
		if ( !roots.has( '.' ) ) roots.set( '.', { ecosystem: '', manifest: '' } );

		const ordered = [ ...roots.keys() ]
			.sort( ( a, b ) => a.split( '/' ).length - b.split( '/' ).length || a.localeCompare( b ) )
			.slice( 0, MAX_COMPONENTS );

		const ids = Survey._mintIds( ordered );

		// Deepest-first, so `owner()` finds the most specific component containing a file. The root is
		// EXCLUDED from the candidates and used as the fallback: it contains everything by definition,
		// so leaving it in the search would let it swallow every file it happened to be tested against
		// first ( it shares a path-depth with any top-level component ).
		const byDepth = ordered.filter( r => r !== '.' )
			.sort( ( a, b ) => b.split( '/' ).length - a.split( '/' ).length );
		const owner   = ( rel: string ): string =>
			byDepth.find( r => rel === r || rel.startsWith( r + '/' ) ) ?? '.';

		const buckets = new Map<string, RawFile[]>( ordered.map( r => [ r, [] ] ) );
		for ( const f of files ) buckets.get( owner( f.rel ) )?.push( f );

		// Nesting is by NEAREST ANCESTOR COMPONENT, not by direct path parent — the directory between
		// two components often carries no manifest of its own ( `kcd_all_mcps/` holding servers, say ),
		// and matching on the path parent alone orphans everything beneath it.
		const parentOf = new Map<string, string>();
		for ( const r of ordered ) {
			if ( r === '.' ) continue;
			parentOf.set( r, byDepth.find( o => o !== r && r.startsWith( o + '/' ) ) ?? '.' );
		}

		return ordered.map( ( cRoot ) => {
			const meta   = roots.get( cRoot )!;
			const bucket = buckets.get( cRoot ) ?? [];
			const abs    = path.join( root, cRoot === '.' ? '' : cRoot );

			// Languages, ranked.
			const langs = new Map<string, number>();
			let bytes = 0, testFiles = 0;
			const testDirs = new Set<string>(), patterns = new Set<string>();

			for ( const f of bucket ) {
				bytes += f.size;
				const language = LANGUAGES[ path.extname( f.base ).toLowerCase() ];
				if ( language ) langs.set( language, ( langs.get( language ) ?? 0 ) + 1 );

				let matched = false;
				for ( const p of TEST_PATTERNS ) if ( p.test( f.base ) ) { patterns.add( p.pattern ); matched = true; }
				if ( matched || f.inTestDir ) {
					testFiles++;
					const d = f.rel.slice( 0, f.rel.lastIndexOf( '/' ) );
					if ( d ) testDirs.add( d );
				}
			}

			const languages = [ ...langs.entries() ]
				.map( ( [ language, n ] ) => ( { language, files: n } ) )
				.sort( ( a, b ) => b.files - a.files )
				.slice( 0, MAX_LANGUAGES );

			const meta2 = meta.manifest ? Survey._manifestMeta( path.join( root, meta.manifest ) ) : {};
			const entryPoints = Survey._entryPoints( abs, meta.manifest ? path.join( root, meta.manifest ) : undefined );

			const contains = ordered.filter( o => parentOf.get( o ) === cRoot ).map( o => ids.get( o )! );

			const kind = Survey._kind( cRoot, meta.ecosystem, meta2.name, languages, meta2.hasBin, meta2.isApp );
			const stats = { files: bucket.length, bytes };

			const c: SurveyComponent = {
				id:          ids.get( cRoot )!,
				kind,
				path:        cRoot,
				name:        meta2.name,
				version:     meta2.version,
				ecosystem:   meta.ecosystem || undefined,
				manifest:    meta.manifest || undefined,
				description: '',
				languages,
				entryPoints: entryPoints.slice( 0, MAX_ENTRY_POINTS ),
				tests: {
					present:     testFiles > 0,
					files:       testFiles,
					directories: [ ...testDirs ].sort().slice( 0, MAX_TEST_DIRS ),
					patterns:    [ ...patterns ].sort(),
				},
				contains,
				stats,
			};
			c.description = Survey._describe( c );
			return c;
		} );
	}

	/** Short, stable, filename-safe, collision-free ids derived from the component's own directory. */
	private static _mintIds( roots: string[] ): Map<string, string> {
		const ids  = new Map<string, string>();
		const seen = new Set<string>( [ INDEX_FILE.replace( /\.json$/, '' ) ] );

		const safe = ( s: string ): string => s.replace( /[^A-Za-z0-9._-]/g, '-' ).replace( /^-+|-+$/g, '' );

		for ( const r of roots ) {
			const segs = r === '.' ? [ 'root' ] : r.split( '/' );

			// Widen leftwards through the path until the id is unique: two components both called
			// `daedalus` become `daedalus` and `mcp-daedalus`, which says WHICH one — where a numeric
			// suffix ( `daedalus-2` ) only says "there was another".
			let id = 'component';
			for ( let take = 1; take <= segs.length; take++ ) {
				id = segs.slice( segs.length - take ).map( safe ).filter( Boolean ).join( '-' ) || 'component';
				if ( !seen.has( id ) ) break;
			}
			const base = id;
			for ( let n = 2; seen.has( id ); n++ ) id = `${ base }-${ n }`;

			seen.add( id );
			ids.set( r, id );
		}
		return ids;
	}

	/** The coarsest honest classification. `unknown` is a fine answer. */
	private static _kind(
		cRoot: string, ecosystem: string, name: string | undefined,
		languages: SurveyLanguage[], hasBin?: boolean, isApp?: boolean,
	): ComponentKind {
		if ( /(^|\/)(plugins?|extensions?|addons?)(\/|$)/i.test( cRoot ) || /-plugin$|^plugin-/i.test( name ?? '' ) ) return 'plugin';
		if ( isApp ) return 'application';
		if ( hasBin ) return 'tool';
		const top = languages[ 0 ]?.language;
		if ( !ecosystem && ( top === 'HTML' || top === 'Markdown' ) ) return 'docs';
		if ( !ecosystem ) return 'unknown';
		return cRoot === '.' ? 'application' : 'library';
	}

	/** The mechanical sentence — a PROTOTYPE description, meant to be rewritten by whoever knows better. */
	private static _describe( c: SurveyComponent ): string {
		const langs = c.languages.slice( 0, 3 ).map( l => l.language ).join( '/' );
		const bits: string[] = [];
		bits.push( `${ langs || 'Non-code' } ${ c.ecosystem ? `${ c.ecosystem } ` : '' }${ c.kind }` );
		bits.push( `${ c.stats.files } files` );
		if ( c.entryPoints.length ) bits.push( `entry ${ c.entryPoints[ 0 ]!.path }` );
		bits.push( c.tests.present ? `${ c.tests.files } test files` : 'no tests found' );
		if ( c.contains.length ) bits.push( `${ c.contains.length } sub-component${ c.contains.length === 1 ? '' : 's' }` );
		return bits.join( ', ' ) + '.';
	}

	/**
	 * Name / version / bin off a manifest, best-effort. JSON is parsed; everything else is matched
	 * with a narrow regex rather than pulling TOML/YAML/XML parsers into the SDK for two fields. A
	 * miss returns nothing — a manifest's PRESENCE is the load-bearing signal, not its metadata.
	 */
	private static _manifestMeta( abs: string ): { name?: string; version?: string; hasBin?: boolean; isApp?: boolean } {
		let text: string;
		try { text = fs.readFileSync( abs, 'utf8' ); } catch { return {}; }
		if ( text.length > 200_000 ) return {};

		if ( abs.endsWith( '.json' ) ) {
			try {
				const j = JSON.parse( text ) as {
					name?: unknown; version?: unknown; bin?: unknown;
					dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown>;
				};
				const declared = { ...j.dependencies, ...j.devDependencies };
				return {
					name:    typeof j.name    === 'string' ? j.name    : undefined,
					version: typeof j.version === 'string' ? j.version : undefined,
					hasBin:  Boolean( j.bin ),
					isApp:   APP_FRAMEWORKS.some( f => f in declared ),
				};
			} catch { return {}; }
		}
		return {
			name:    text.match( /^\s*(?:name|module)\s*[=:]\s*["']?([^"'\n\r]+)/mi )?.[ 1 ]?.trim(),
			version: text.match( /^\s*version\s*[=:]\s*["']?([^"'\n\r]+)/mi )?.[ 1 ]?.trim(),
		};
	}

	/** Declared entry points first ( a manifest saying so is evidence ), conventional ones second. */
	private static _entryPoints( componentAbs: string, manifestAbs?: string ): SurveyEntryPoint[] {
		const found = new Map<string, SurveyEntryPoint>();

		if ( manifestAbs?.endsWith( '.json' ) ) {
			try {
				const pkg = JSON.parse( fs.readFileSync( manifestAbs, 'utf8' ) ) as { main?: unknown; module?: unknown; bin?: unknown };
				const put = ( v: unknown, field: string ): void => {
					if ( typeof v === 'string' ) found.set( v, { path: v, source: 'manifest', note: field } );
				};
				put( pkg.main, 'main' );
				put( pkg.module, 'module' );
				if ( typeof pkg.bin === 'string' ) put( pkg.bin, 'bin' );
				else if ( pkg.bin && typeof pkg.bin === 'object' )
					for ( const [ k, v ] of Object.entries( pkg.bin as Record<string, unknown> ) ) put( v, `bin.${ k }` );
			} catch { /* an unreadable manifest is not a survey failure */ }
		}

		for ( const cand of CONVENTIONAL_ENTRIES ) {
			if ( found.has( cand ) ) continue;
			if ( fs.existsSync( path.join( componentAbs, cand ) ) ) found.set( cand, { path: cand, source: 'convention' } );
		}

		return [ ...found.values() ].sort( ( a, b ) =>
			a.source === b.source ? a.path.localeCompare( b.path ) : a.source === 'manifest' ? -1 : 1 );
	}
}
