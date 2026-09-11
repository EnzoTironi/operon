import * as fs from "node:fs";
import path from "node:path";

/**
 * File system and path I/O boundary helpers for CLI.
 * Isolated from Effect imports to keep runtime boundary clean.
 */

export function readTextFileSync(filePath: string | number): string {
  return fs.readFileSync(filePath, "utf-8");
}

export function writeTextFileSync(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, "utf-8");
}

export function fileExistsSync(filePath: string): boolean {
  return fs.existsSync(filePath);
}

export function unlinkFileSync(filePath: string): void {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function readStdinSync(): string {
  return fs.readFileSync(0, "utf-8").trim() || "{}";
}

export function resolvePath(...paths: string[]): string {
  return path.resolve(...paths);
}

export function joinPath(...paths: string[]): string {
  return path.join(...paths);
}
