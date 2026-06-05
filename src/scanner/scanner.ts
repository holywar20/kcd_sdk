import * as fs from 'fs';
import * as path from 'path';

export interface ScanOptions {
  pattern?: string;
}

export interface ScannedFile {
  path: string;
  relativePath: string;
  frontmatter: Record<string, unknown>;
  rawLinks: Array<{ href: string; text: string }>;
  body: string;
}

export function scan(root: string, opts?: ScanOptions): ScannedFile[] {
  // Phase 0.c — placeholder; returns empty until implemented
  void root;
  void opts;
  return [];
}
