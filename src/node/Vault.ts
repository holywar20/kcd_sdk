import * as fs from 'fs';
import * as path from 'path';
import { LensObject, Glob } from '../core';
import type { ArtifactRef, ArtifactType } from '../core';
import { scan } from '../scanner';
import type { ScannedFile } from '../scanner';
import { inferProjectRoot, loadLensFromDisk } from './io';

/**
 * Vault — a KCD document store bound to one ( projectRoot, docRoot ) pair.
 *
 * The single facade for everything done against a vault: path math,
 * classification, scanning, glob, and disk read/write. Consumers hold ONE
 * bound object instead of threading roots through a scatter of free functions
 * ( scan, classifyByPath, resolveHref, loadLensFromDisk, … ) — the import
 * surface stays a named object, not a bag of methods.
 *
 * Node-side by design: it touches disk. The renderer receives serialized
 * artifacts over the bridge and never needs a Vault.
 */
export class Vault {

	/** Absolute vault root — projectRoot/docRoot, resolved once. */
	readonly root: string;

	constructor( private projectRoot: string, private docRoot: string = LensObject.DEFAULT_DOC_ROOT ) {
		this.root = path.resolve( path.join( projectRoot, docRoot ) );
	}

	/** Build a Vault by walking up from a start path until an ancestor holds the doc root. */
	static infer( startPath: string, docRoot: string = LensObject.DEFAULT_DOC_ROOT ): Vault {
		return new Vault( inferProjectRoot( startPath, docRoot ), docRoot );
	}

	// ── Path math ───────────────────────────────────────────────────────────

	/**
	 * Vault-relative path → absolute path anchored at the vault root.
	 * Absolute inputs are normalized as-is ( isInside still rejects out-of-vault ones ),
	 * so callers passing absolute paths keep working regardless of process cwd.
	 */
	toAbs( vaultRelative: string ): string {
		return path.isAbsolute( vaultRelative )
			? path.normalize( vaultRelative )
			: path.resolve( this.root, vaultRelative );
	}

	/** Absolute ( or vault-relative ) path → vault-relative path, for return payloads. */
	toVaultRel( anyPath: string ): string {
		return path.relative( this.root, this.toAbs( anyPath ) );
	}

	/** True when the path resolves inside the vault root — the path-jail predicate. */
	isInside( anyPath: string ): boolean {
		const rel = path.relative( this.root, this.toAbs( anyPath ) );
		return !rel.startsWith( '..' ) && !path.isAbsolute( rel );
	}

	// ── KCD semantics ─────────────────────────────────────────────────────────

	/** Classify a path ( vault-relative or absolute ) into its ArtifactType. */
	classify( anyPath: string ): ArtifactType {
		return LensObject.classifyByPath( this.toAbs( anyPath ), this.projectRoot, this.docRoot );
	}

	/** Resolve a raw link href to an absolute path, against this vault's project root. */
	resolveHref( href: string ): string {
		return LensObject.resolveHref( href, this.projectRoot );
	}

	/** A scanned file → its ArtifactRef ( vault-relative path + type + display name ). */
	toRef( file: ScannedFile ): ArtifactRef {
		return {
			path: file.relativePath,
			type: this.classify( file.path ),
			name: typeof file.frontmatter[ 'name' ] === 'string'
				? file.frontmatter[ 'name' ] as string
				: path.basename( file.relativePath, '.html' ),
		};
	}

	// ── Disk ────────────────────────────────────────────────────────────────

	/** Scan the whole vault, returning every artifact file with parsed frontmatter and links. */
	scan(): ScannedFile[] {
		return scan( this.root );
	}

	/** Scanned files whose vault-relative path matches a glob ( * within a segment, ** across ). */
	glob( pattern: string ): ScannedFile[] {
		return this.scan().filter( f => Glob.matches( f.relativePath, pattern ) );
	}

	/** Raw file content at a vault path ( HTML for artifacts ). */
	read( vaultRelative: string ): string {
		return fs.readFileSync( this.toAbs( vaultRelative ), 'utf-8' );
	}

	/** Write content to a vault path ( creating parent dirs ); returns the vault-relative path written. */
	write( vaultRelative: string, content: string ): string {
		const abs = this.toAbs( vaultRelative );
		fs.mkdirSync( path.dirname( abs ), { recursive: true } );
		fs.writeFileSync( abs, content, 'utf-8' );
		return this.toVaultRel( abs );
	}

	/** Dredge a lens from a vault path, with the real fs reader injected. */
	loadLens( vaultRelative: string, opts?: { depth?: number; eager?: boolean } ): LensObject {
		return loadLensFromDisk( this.toAbs( vaultRelative ), {
			projectRoot: this.projectRoot,
			depth:       opts?.depth,
			eager:       opts?.eager,
		} );
	}

}
