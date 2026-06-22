export type MemberKind = 'method' | 'property'

export type ExportKind =
	| 'class'
	| 'const-object'
	| 'const-function'
	| 'const-value'
	| 'function'
	| 'interface'
	| 'type'
	| 'enum'

export interface ManifestMember {
	name:  string
	kind:  MemberKind
	line:  number
}

export interface ManifestExport {
	name:     string
	kind:     ExportKind
	line:     number
	members?: ManifestMember[]
}

export interface LocalImport {
	name:      string
	from:      string
	path:      string   // repo-relative, forward slashes
	typeOnly?: true
}

export interface ExternalImport {
	name:      string
	from:      string
	typeOnly?: true
}

export interface ManifestType {
	name:     string
	kind:     'type' | 'interface'
	exported: boolean
	line:     number
}

export interface ManifestFile {
	file:    string   // repo-relative, forward slashes
	cluster: string
	exports: ManifestExport[]
	imports: {
		local:    LocalImport[]
		external: ExternalImport[]
	}
	types: ManifestType[]
}

export interface CodeManifest {
	generated: string   // ISO date
	root:      string
	files:     ManifestFile[]
}
