import fs from "node:fs";
import fsAsync from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

const SENTINEL_FILENAME = "config-probe-sentinel.json";

export type ConfigProbeSentinel = {
  attempt: number;
  writtenAt: number;
};

export function resolveConfigProbeSentinelPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), SENTINEL_FILENAME);
}

/**
 * Synchronously write the config probe sentinel to disk.
 * Must be synchronous so it completes before SIGUSR1 is emitted.
 */
export function writeConfigProbeSentinelSync(
  payload: { attempt: number },
  env: NodeJS.ProcessEnv = process.env,
): void {
  const filePath = resolveConfigProbeSentinelPath(env);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const data: ConfigProbeSentinel = {
    attempt: payload.attempt,
    writtenAt: Date.now(),
  };
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

export async function readConfigProbeSentinel(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ConfigProbeSentinel | null> {
  const filePath = resolveConfigProbeSentinelPath(env);
  try {
    const raw = await fsAsync.readFile(filePath, "utf-8");
    let parsed: ConfigProbeSentinel | undefined;
    try {
      parsed = JSON.parse(raw) as ConfigProbeSentinel | undefined;
    } catch {
      await fsAsync.unlink(filePath).catch(() => {});
      return null;
    }
    if (!parsed || typeof parsed.attempt !== "number" || typeof parsed.writtenAt !== "number") {
      await fsAsync.unlink(filePath).catch(() => {});
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function deleteConfigProbeSentinel(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const filePath = resolveConfigProbeSentinelPath(env);
  await fsAsync.unlink(filePath).catch(() => {});
}

/**
 * Returns true if the sentinel's writtenAt timestamp is older than maxAgeMs.
 * Stale sentinels are left over from OOM kills, operator restarts, or other
 * non-config-failure restarts and should be ignored rather than triggering rollback.
 */
export function isConfigProbeSentinelStale(
  sentinel: ConfigProbeSentinel,
  maxAgeMs = 10 * 60 * 1000,
): boolean {
  return Date.now() - sentinel.writtenAt > maxAgeMs;
}
