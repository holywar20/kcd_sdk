import { describe, it, expect } from 'vitest'
import { EsCsv } from '../EsCsv'

describe( 'EsCsv.parse', () => {

	it( 'parses a plain file row', () => {
		const out = EsCsv.parse( '"_package.json","C:\\Code\\proj\\_package.json","A",1466,2026-06-18T21:43:00Z' )
		expect( out ).toEqual( [ {
			name:  '_package.json',
			path:  'C:\\Code\\proj\\_package.json',
			isDir: false,
			size:  1466,
			ext:   'json',
			mtime: Date.parse( '2026-06-18T21:43:00Z' )
		} ] )
	} )

	it( 'reads a directory row (Attributes contains D) — size/ext are folder-appropriate', () => {
		const out = EsCsv.parse( '"BerryPlant","E:\\Steam\\workshop\\BerryPlant","D",0,2026-02-20T00:00:00Z' )
		expect( out[ 0 ] ).toMatchObject( { name: 'BerryPlant', isDir: true, ext: '' } )
	} )

	it( 'survives a comma embedded INSIDE a quoted field — the exact shape seen live on the dev machine', () => {
		// Real example: C:\ProgramData\Microsoft\VisualStudio\Packages\CoreEditorFonts,version=17.7.40001.1,productarch=neutral\_package.json
		// A naive split(',') would shred this path across several bogus columns; es.exe correctly
		// double-quotes it as ONE field, which is exactly what this test locks in.
		const line = '"_package.json","C:\\ProgramData\\Packages\\CoreEditorFonts,version=17.7.40001.1,productarch=neutral","A",1466,2026-06-18T21:43:00Z'
		const out = EsCsv.parse( line )
		expect( out ).toHaveLength( 1 )
		expect( out[ 0 ].path ).toBe( 'C:\\ProgramData\\Packages\\CoreEditorFonts,version=17.7.40001.1,productarch=neutral' )
	} )

	it( 'unescapes a doubled quote ( "" ) inside a quoted field', () => {
		const out = EsCsv.parse( '"say ""hi"" file.txt","C:\\say ""hi"" file.txt","A",10,2026-01-01T00:00:00Z' )
		expect( out[ 0 ].name ).toBe( 'say "hi" file.txt' )
	} )

	it( 'parses multiple lines, skipping blanks', () => {
		const text = [
			'"a.txt","C:\\a.txt","A",1,2026-01-01T00:00:00Z',
			'',
			'"b.txt","C:\\b.txt","A",2,2026-01-02T00:00:00Z'
		].join( '\r\n' )
		expect( EsCsv.parse( text ).map( ( e ) => e.name ) ).toEqual( [ 'a.txt', 'b.txt' ] )
	} )

	it( 'skips a malformed row instead of throwing', () => {
		const text = [
			'"a.txt","C:\\a.txt","A",1,2026-01-01T00:00:00Z',
			'not,enough,columns',
			'"b.txt","C:\\b.txt","A",2,2026-01-02T00:00:00Z'
		].join( '\n' )
		expect( EsCsv.parse( text ).map( ( e ) => e.name ) ).toEqual( [ 'a.txt', 'b.txt' ] )
	} )

	it( 'falls back to mtime 0 for an unparseable date rather than NaN', () => {
		const out = EsCsv.parse( '"a.txt","C:\\a.txt","A",1,not-a-date' )
		expect( out[ 0 ].mtime ).toBe( 0 )
	} )
} )
