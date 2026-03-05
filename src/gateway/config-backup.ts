import fs from "node:fs/promises";
import path from "node:path";

/**
 * Restore the most recent timestamped config backup to configPath.
 * Returns true if a backup was found and restored, false otherwise.
 */
export async function restoreLatestConfigBackup(
  configPath: string,
  log: { warn: (msg: string) => void; error: (msg: string) => void },
): Promise<boolean> {
  const configDir = path.dirname(configPath);
  const configBase = path.basename(configPath);
  const bakPrefix = `${configBase}.bak.`;

  let backups: string[] = [];
  try {
    const all = await fs.readdir(configDir);
    backups = all
      .filter((e) => e.startsWith(bakPrefix))
      .toSorted()
      .map((e) => path.join(configDir, e));
  } catch {
    backups = [];
  }

  if (backups.length === 0) {
    return false;
  }

  const latest = backups[backups.length - 1];
  try {
    await fs.copyFile(latest, configPath);
    log.warn(`config-watchdog: restored config from backup: ${latest}`);
    return true;
  } catch (err) {
    log.error(`config-watchdog: failed to restore config backup: ${String(err)}`);
    return false;
  }
}
