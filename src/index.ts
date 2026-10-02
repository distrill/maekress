import { startTui } from "./tui.ts";
import { loadLatestSession, loadSession } from "./sessions.ts";

const args = process.argv.slice(2);
if (args.length !== 0 && (args[0] !== "restore" || args.length > 2)) {
  console.error("Usage: maekress [restore [session_id]]");
  process.exitCode = 1;
} else {
  try {
    // Fail before importing/starting the native TUI when Node cannot load its
    // FFI backend. OpenTUI otherwise fails late, after the terminal may already
    // have been switched into its interactive mode.
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major! < 26 || (major === 26 && minor! < 4)) {
      throw new Error(`This harness needs Node.js 26.4 or newer (found ${process.versions.node}). Check with: node --version`);
    }
    process.stderr.write(`Starting maekress with Node.js ${process.versions.node}…\n`);
    const session = args.length ? await (args[1] ? loadSession(args[1]) : loadLatestSession()) : undefined;
    if (session && session.projectRoot !== process.cwd()) {
      throw new Error(`This session belongs to ${session.projectRoot}. Run maekress from that directory to restore it.`);
    }
    await startTui(session);
  } catch (error) {
    console.error(`Could not start maekress: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
