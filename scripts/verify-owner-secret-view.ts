// Transport/lifecycle checks only. No real dialog, database identity, or screenshot.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { showLocalEnrollmentUri } from "./local-owner-secret-view";

async function verify() {
  const originalSpawn = childProcess.spawn;
  const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const uri = `otpauth://totp/Disposable?secret=${randomBytes(20).toString("hex")}`;
  let passed = 0;
  let viewerProgram = "";
  try {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    for (const outcome of ["done", "cancel", "interrupt", "spawn-error", "pipe-error"] as const) {
      const child = new EventEmitter() as childProcess.ChildProcess;
      const pipe = new EventEmitter() as EventEmitter & { end: (value: string) => void };
      pipe.end = value => {
        assert.equal(value, uri);
        setImmediate(() => {
          if (outcome === "interrupt") process.emit("SIGINT");
          else if (outcome === "spawn-error") child.emit("error", new Error("Unavailable"));
          else if (outcome === "pipe-error") pipe.emit("error", new Error("Closed"));
          else child.emit("exit", outcome === "done" ? 0 : 2);
        });
      };
      Object.defineProperty(child, "stdin", { value: pipe });
      child.kill = () => { setImmediate(() => child.emit("exit", null, "SIGTERM")); return true; };
      childProcess.spawn = ((command, args, options) => {
        assert.equal(command, "powershell.exe");
        assert.ok(Array.isArray(args));
        assert.ok(!args.join(" ").includes(uri));
        assert.ok(!args.join(" ").includes(new URL(uri).searchParams.get("secret")!));
        const program = args.at(-1)!;
        viewerProgram = program;
        assert.ok(program.includes("$operatorProcess.HasExited"));
        assert.ok(program.includes("$box.Text = ''"));
        assert.ok(program.includes("exit 2"));
        assert.ok(options && "env" in options && options.env);
        assert.equal(options.env.DATABASE_URL, undefined);
        assert.equal(options.env.BETTER_AUTH_SECRET, undefined);
        assert.deepEqual(options.stdio, ["pipe", "ignore", "ignore"]);
        return child;
      }) as typeof childProcess.spawn;
      syncBuiltinESMExports();
      const listeners = ["exit", "SIGINT", "SIGTERM"].map(event => process.listenerCount(event));
      if (outcome === "done") await showLocalEnrollmentUri(uri);
      else await assert.rejects(showLocalEnrollmentUri(uri));
      assert.deepEqual(["exit", "SIGINT", "SIGTERM"].map(event => process.listenerCount(event)), listeners);
      passed++; console.log(`PASS: private viewer ${outcome} transport/lifecycle`);
    }
    // Parse the actual static Windows program without showing a dialog or sending a URI.
    await new Promise<void>((resolve, reject) => {
      const child = originalSpawn("powershell.exe", ["-NoLogo", "-NoProfile", "-Command",
        "$tokens=$null; $parseErrors=$null; [void][System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(),[ref]$tokens,[ref]$parseErrors); if ($parseErrors.Count -gt 0) { exit 1 }"],
      { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
      child.once("error", reject);
      child.once("exit", code => code === 0 ? resolve() : reject(new Error("Invalid viewer program")));
      child.stdin.on("error", reject); child.stdin.end(viewerProgram);
    });
    passed++; console.log("PASS: installed Windows PowerShell parses viewer program (no GUI)");
  } finally {
    childProcess.spawn = originalSpawn; syncBuiltinESMExports();
    if (stdinTTY) Object.defineProperty(process.stdin, "isTTY", stdinTTY); else Reflect.deleteProperty(process.stdin, "isTTY");
    if (stdoutTTY) Object.defineProperty(process.stdout, "isTTY", stdoutTTY); else Reflect.deleteProperty(process.stdout, "isTTY");
  }
  console.log(`${passed} automated viewer checks passed; human GUI acceptance NOT performed.`);
}
verify().catch(() => { console.error("Private viewer verification failed; details withheld."); process.exitCode = 1; });
