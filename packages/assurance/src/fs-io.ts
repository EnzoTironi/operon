import * as fs from "node:fs";
import path from "node:path";

/**
 * File system and path I/O boundary helpers for assurance.
 * Isolated from Effect imports to keep runtime boundary clean.
 */

export function fileExistsSync(filePath: string): boolean {
  return fs.existsSync(filePath);
}

export function readDirWithTypesSync(dirPath: string): fs.Dirent[] {
  return fs.readdirSync(dirPath, { withFileTypes: true });
}

export function readTextFileSync(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8");
}

export function writeTextFileSync(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, "utf-8");
}

export function makeTempDirSync(prefix: string): string {
  return fs.mkdtempSync(prefix);
}

export function rmDirRecursiveSync(dirPath: string): void {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

export function makeDirSync(dirPath: string): void {
  fs.mkdirSync(dirPath);
}

export function joinPath(...paths: string[]): string {
  return path.join(...paths);
}

export function relativePath(from: string, to: string): string {
  return path.relative(from, to);
}
