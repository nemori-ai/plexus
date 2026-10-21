import { spawn } from "node:child_process";

export interface CaptureResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type CaptureSpawn = (spec: {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}) => Promise<CaptureResult>;

export type ResolveBinary = (name: string) => Promise<string | undefined>;

/** stdin is `/dev/null`: `codex exec` otherwise waits on "additional input from stdin". */
export const defaultCapture: CaptureSpawn = (spec) =>
  new Promise<CaptureResult>((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env ? { ...process.env, ...spec.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (spec.timeoutMs && spec.timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, spec.timeoutMs);
    }
    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (c: string) => {
      stdout += c;
    });
    child.stderr?.on("data", (c: string) => {
      stderr += c;
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code });
    });
  });
