import {
  readInterruptHookInput,
  runCodexInterruptHook,
} from "./provider-control.js";

const metadataPath = process.argv[2];
try {
  if (!metadataPath)
    throw new Error("Interrupt hook metadata path is missing.");
  await runCodexInterruptHook(
    metadataPath,
    await readInterruptHookInput(process.stdin),
  );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Codex Interrupt hook failed.",
  );
  process.exitCode = 1;
}
