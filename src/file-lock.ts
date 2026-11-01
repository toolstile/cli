import { mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function fileText(path: string): string | null {
  try { return readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Fail closed rather than steal a lock from a possibly live command. */
export function withFileLock<T>(path: string, run: () => T): T {
  mkdirSync(dirname(path), { recursive: true });
  let canonical: string;
  try { canonical = realpathSync(path); }
  catch { canonical = resolve(realpathSync(dirname(path)), path.split(/[\\/]/).pop()!); }
  const lock = `${canonical}.toolstile-lock`;
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(`Another command is updating ${path}. Retry when it finishes. If it crashed, remove ${lock}.`);
    throw error;
  }
  try { return run(); }
  finally { rmSync(lock, { recursive: true }); }
}
