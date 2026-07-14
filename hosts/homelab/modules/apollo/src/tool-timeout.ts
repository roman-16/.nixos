import {
  type ExtensionAPI,
  type ExtensionFactory,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";

/** Hard ceiling, in seconds, on how long a single tool call may run. */
export const TOOL_TIMEOUT_SECONDS = 60;

/** Clamp a bash timeout to the hard cap, defaulting an unset one to the cap. */
export function cappedTimeout(requested: number | undefined): number {
  return requested == null ? TOOL_TIMEOUT_SECONDS : Math.min(requested, TOOL_TIMEOUT_SECONDS);
}

/**
 * Enforce a hard per-tool-call time limit. bash is the only built-in tool that spawns a
 * process and can run unbounded, so its `timeout` is capped (and defaulted) to
 * TOOL_TIMEOUT_SECONDS - pi kills the process tree when that's hit, so it's a real
 * limit. The fs tools (read/write/edit) return near-instantly and have nothing to bound.
 */
export function createToolTimeoutExtension(): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.on("tool_call", (event) => {
      if (isToolCallEventType("bash", event)) {
        event.input.timeout = cappedTimeout(event.input.timeout);
      }
    });
  };
}
