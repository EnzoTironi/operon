import { randomUUID } from "node:crypto";
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

export function writeTextFileAtomicSync(
  filePath: string,
  content: string
): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, {
      encoding: "utf-8",
      mode: 0o600,
      flush: true,
    });
    fs.renameSync(temporary, filePath);
    const descriptor = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
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
