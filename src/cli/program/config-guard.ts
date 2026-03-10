import { loadAndMaybeMigrateDoctorConfig } from "../../commands/doctor-config-flow.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { formatConfigIssueLines } from "../../config/issue-format.js";
import type { RuntimeEnv } from "../../runtime.js";
import { colorize, isRich, theme } from "../../terminal/theme.js";
import { shortenHomePath } from "../../utils.js";
import { shouldMigrateStateFromPath } from "../argv.js";
import { formatCliCommand } from "../command-format.js";

const ALLOWED_INVALID_COMMANDS = new Set(["doctor", "logs", "health", "help", "status"]);
const ALLOWED_INVALID_GATEWAY_SUBCOMMANDS = new Set([
  "status",
  "probe",
  "health",
  "discover",
  "call",
  "install",
  "uninstall",
  "start",
  "stop",
  "restart",
]);
let didRunDoctorConfigFlow = false;
let configSnapshotPromise: Promise<Awaited<ReturnType<typeof readConfigFileSnapshot>>> | null =
  null;

function resetConfigGuardStateForTests() {
  didRunDoctorConfigFlow = false;
  configSnapshotPromise = null;
}

async function getConfigSnapshot() {
  // Tests often mutate config fixtures; caching can make those flaky.
  if (process.env.VITEST === "true") {
    return readConfigFileSnapshot();
  }
  configSnapshotPromise ??= readConfigFileSnapshot();
  return configSnapshotPromise;
}

export async function ensureConfigReady(params: {
  runtime: RuntimeEnv;
  commandPath?: string[];
  suppressDoctorStdout?: boolean;
}): Promise<void> {
  const commandPath = params.commandPath ?? [];
  if (!didRunDoctorConfigFlow && shouldMigrateStateFromPath(commandPath)) {
    didRunDoctorConfigFlow = true;
    const runDoctorConfigFlow = async () =>
      loadAndMaybeMigrateDoctorConfig({
        options: { nonInteractive: true },
        confirm: async () => false,
      });
    if (!params.suppressDoctorStdout) {
      await runDoctorConfigFlow();
    } else {
      const originalStdoutWrite = process.stdout.write.bind(process.stdout);
      const originalSuppressNotes = process.env.OPENCLAW_SUPPRESS_NOTES;
      process.stdout.write = (() => true) as unknown as typeof process.stdout.write;
      process.env.OPENCLAW_SUPPRESS_NOTES = "1";
      try {
        await runDoctorConfigFlow();
      } finally {
        process.stdout.write = originalStdoutWrite;
        if (originalSuppressNotes === undefined) {
          delete process.env.OPENCLAW_SUPPRESS_NOTES;
        } else {
          process.env.OPENCLAW_SUPPRESS_NOTES = originalSuppressNotes;
        }
      }
    }
  }

  const snapshot = await getConfigSnapshot();
  const commandName = commandPath[0];
  const subcommandName = commandPath[1];
  const allowInvalid = commandName
    ? ALLOWED_INVALID_COMMANDS.has(commandName) ||
      (commandName === "gateway" &&
        subcommandName &&
        ALLOWED_INVALID_GATEWAY_SUBCOMMANDS.has(subcommandName))
    : false;
  const issues =
    snapshot.exists && !snapshot.valid
      ? formatConfigIssueLines(snapshot.issues, "-", { normalizeRoot: true })
      : [];
  const legacyIssues =
    snapshot.legacyIssues.length > 0 ? formatConfigIssueLines(snapshot.legacyIssues, "-") : [];

  const invalid = snapshot.exists && !snapshot.valid;
  if (!invalid) {
    return;
  }

  // Gateway foreground run (no subcommand): if a watchdog sentinel exists from a
  // prior failed boot, attempt config rollback here instead of showing doctor UI
  // and exiting.  This covers the case where invalid config prevents
  // runGatewayCommand from ever reaching its own sentinel-check logic.
  if (commandName === "gateway" && !subcommandName) {
    try {
      const {
        readConfigProbeSentinel,
        writeConfigProbeSentinelSync,
        deleteConfigProbeSentinel,
        isConfigProbeSentinelStale,
      } = await import("../../infra/config-probe-sentinel.js");
      const existingSentinel = await readConfigProbeSentinel();
      if (existingSentinel && !isConfigProbeSentinelStale(existingSentinel)) {
        if (existingSentinel.attempt >= 3) {
          params.runtime.error(
            "[config-watchdog] exhausted rollback attempts, proceeding to doctor exit",
          );
          await deleteConfigProbeSentinel();
          // Fall through to the standard invalid-config exit below.
        } else {
          const { restoreLatestConfigBackup } = await import("../../gateway/config-backup.js");
          const { CONFIG_PATH } = await import("../../config/config.js");
          const log = {
            warn: (m: string) => params.runtime.error(m),
            error: (m: string) => params.runtime.error(m),
          };
          params.runtime.error(
            `[config-watchdog] invalid config with sentinel (attempt=${existingSentinel.attempt}), attempting rollback`,
          );
          const restored = await restoreLatestConfigBackup(CONFIG_PATH, log);
          if (restored) {
            writeConfigProbeSentinelSync({ attempt: existingSentinel.attempt + 1 });
            // Reset snapshot cache so the next call picks up the restored config.
            configSnapshotPromise = null;
            params.runtime.error(
              `[config-watchdog] rollback succeeded (attempt ${existingSentinel.attempt + 1}), retrying config check`,
            );
            return ensureConfigReady(params);
          } else {
            params.runtime.error("[config-watchdog] no backup available, cannot rollback");
            await deleteConfigProbeSentinel();
            // Fall through to the standard invalid-config exit below.
          }
        }
      }
    } catch {
      // best-effort — watchdog failures must never block startup path
    }
  }

  const rich = isRich();
  const muted = (value: string) => colorize(rich, theme.muted, value);
  const error = (value: string) => colorize(rich, theme.error, value);
  const heading = (value: string) => colorize(rich, theme.heading, value);
  const commandText = (value: string) => colorize(rich, theme.command, value);

  params.runtime.error(heading("Config invalid"));
  params.runtime.error(`${muted("File:")} ${muted(shortenHomePath(snapshot.path))}`);
  if (issues.length > 0) {
    params.runtime.error(muted("Problem:"));
    params.runtime.error(issues.map((issue) => `  ${error(issue)}`).join("\n"));
  }
  if (legacyIssues.length > 0) {
    params.runtime.error(muted("Legacy config keys detected:"));
    params.runtime.error(legacyIssues.map((issue) => `  ${error(issue)}`).join("\n"));
  }
  params.runtime.error("");
  params.runtime.error(
    `${muted("Run:")} ${commandText(formatCliCommand("openclaw doctor --fix"))}`,
  );
  if (!allowInvalid) {
    params.runtime.exit(1);
  }
}

export const __test__ = {
  resetConfigGuardStateForTests,
};
