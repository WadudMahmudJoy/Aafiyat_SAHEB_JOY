// Transport/lifecycle checks only. No real dialog, database identity, or screenshot.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import decodeQR from "qr/decode.js";
import { buildLocalEnrollmentDisplay, showLocalEnrollmentUri } from "./local-owner-secret-view";

let stage = "QR data checks";

async function verify() {
  const originalSpawn = childProcess.spawn;
  const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const secret = [...randomBytes(32)].map(byte => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[byte & 31]).join("");
  const uri = `otpauth://totp/Aafiyat%20TEST:Disposable?secret=${secret}&issuer=Aafiyat%20TEST`;
  const payload = buildLocalEnrollmentDisplay(uri);
  let passed = 0;
  let viewerProgram = "";
  try {
    assert.equal(payload.manualKey, new URL(uri).searchParams.get("secret"));
    assert.equal(payload.issuer, "Aafiyat TEST"); assert.equal(payload.accountLabel, "Disposable");
    passed++; console.log("PASS: manual key, issuer, account and TOTP settings match disposable URI");
    // Decode the exact GIF sent to Windows using native in-memory imaging.
    // Pixels travel through a private pipe, never terminal output or an image file.
    const pixels = await new Promise<Buffer>((resolve, reject) => {
      const program = `
        $ErrorActionPreference = 'Stop'
        Add-Type -AssemblyName System.Drawing
        $bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())
        $stream = New-Object System.IO.MemoryStream(,$bytes)
        $image = [System.Drawing.Image]::FromStream($stream)
        $bitmap = New-Object System.Drawing.Bitmap($image.Width, $image.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.DrawImageUnscaled($image, 0, 0); $graphics.Dispose()
        $rectangle = New-Object System.Drawing.Rectangle(0, 0, $bitmap.Width, $bitmap.Height)
        $locked = $bitmap.LockBits($rectangle, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        try {
          $rgba = New-Object byte[] ($bitmap.Width * $bitmap.Height * 4)
          [System.Runtime.InteropServices.Marshal]::Copy($locked.Scan0, $rgba, 0, $rgba.Length)
          $output = [Console]::OpenStandardOutput()
          $output.Write([BitConverter]::GetBytes($bitmap.Width), 0, 4)
          $output.Write([BitConverter]::GetBytes($bitmap.Height), 0, 4)
          $output.Write($rgba, 0, $rgba.Length)
        } finally { $bitmap.UnlockBits($locked); $bitmap.Dispose(); $image.Dispose(); $stream.Dispose() }
      `;
      const child = originalSpawn("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", program],
        { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
      const chunks: Buffer[] = [];
      const timeout = setTimeout(() => { child.kill(); reject(new Error("Image decoding timeout")); }, 20_000);
      child.stdout.on("data", chunk => chunks.push(chunk));
      child.once("error", () => { clearTimeout(timeout); reject(new Error("Image decoder unavailable")); });
      child.once("close", code => { clearTimeout(timeout); if (code === 0) resolve(Buffer.concat(chunks)); else reject(new Error("Image decoder failed")); });
      child.stdin.on("error", () => child.kill()); child.stdin.end(payload.qrGifBase64);
    });
    assert.equal(decodeQR({ width: pixels.readInt32LE(0), height: pixels.readInt32LE(4), data: pixels.subarray(8) }, { format: "BGRA" }), uri);
    pixels.fill(0); passed++; console.log("PASS: exact private GIF decodes to the complete disposable enrollment URI");
    const fallbackUri = new URL(uri); fallbackUri.pathname = "/Aafiyat TEST:" + "x".repeat(7000);
    const fallback = buildLocalEnrollmentDisplay(fallbackUri.toString());
    assert.equal(fallback.qrGifBase64, ""); assert.equal(fallback.manualKey, secret);
    passed++; console.log("PASS: QR encoding failure retains private manual setup without error details");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    for (const outcome of ["done", "cancel", "interrupt", "parent-exit", "window-timeout", "spawn-error", "pipe-error"] as const) {
      const child = new EventEmitter() as childProcess.ChildProcess;
      const pipe = new EventEmitter() as EventEmitter & { end: (value: string) => void };
      pipe.end = value => {
        assert.deepEqual(JSON.parse(value), payload);
        setImmediate(() => {
          if (outcome === "interrupt") process.emit("SIGINT");
          else if (outcome === "parent-exit") process.listeners("exit").at(-1)!(0);
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
        assert.ok(program.includes("AddSeconds(120)"));
        assert.ok(program.includes("$box.Text = ''"));
        assert.ok(program.includes("exit 2"));
        assert.ok(options && "env" in options && options.env);
        assert.equal(options.env.DATABASE_URL, undefined);
        assert.equal(options.env.BETTER_AUTH_SECRET, undefined);
        assert.equal(options.windowsHide, false);
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
    // Native control checks use disposable data and close their own forms. They
    // verify events/resources, not human visibility, readability, or phone scanning.
    for (const outcome of ["done", "x", "qr-fallback", "timeout"] as const) {
      stage = `native ${outcome}`;
      const hooks = `
        $form.Add_Shown({
          $valid = $box.Text.Length -eq 0
          $reveal.PerformClick(); $valid = $valid -and ($box.Text -eq $payload.manualKey)
          $reveal.PerformClick(); $valid = $valid -and ($box.Text.Length -eq 0)
          ${outcome === "qr-fallback" ? "$valid = $valid -and ($null -eq $picture.Image) -and $qrStatus.Visible" : "$valid = $valid -and ($null -ne $picture.Image)"}
          if (-not $valid) { $form.Close(); return }
          ${outcome === "x" ? "$form.Close()" : outcome === "timeout" ? "" : "$done.PerformClick()"}
        })
      `;
      const program = viewerProgram.replace("$completed = $false", "$completed = $false\n" + hooks);
      const result = await new Promise<number | null>((resolve, reject) => {
        const child = originalSpawn("powershell.exe", ["-NoLogo", "-NoProfile", "-STA", "-Command", program], {
          stdio: ["pipe", "ignore", "ignore"], windowsHide: false,
          env: { NODE_ENV: "development", SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
            PATH: process.env.PATH, TEMP: process.env.TEMP, TMP: process.env.TMP },
        });
        const timeout = setTimeout(() => { child.kill(); reject(new Error("Native control check timeout")); }, outcome === "timeout" ? 130_000 : 15_000);
        child.once("error", () => { clearTimeout(timeout); reject(new Error("Native control check unavailable")); });
        child.once("close", code => { clearTimeout(timeout); resolve(code); });
        child.stdin.on("error", () => child.kill());
        child.stdin.end(JSON.stringify({ ...payload, ...(outcome === "qr-fallback" ? { qrGifBase64: "invalid image" } : {}) }));
      });
      assert.equal(result, outcome === "x" || outcome === "timeout" ? 2 : 0, "Unexpected native dialog exit status");
      passed++; console.log(`PASS: native disposable dialog ${outcome}, image/manual-key controls (human acceptance pending)`);
    }
    // A terminated owning process must close its private viewer through the actual
    // Windows parent monitor, even when no Node signal handler can run.
    const parent = originalSpawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore", windowsHide: true });
    assert.ok(parent.pid);
    try {
      stage = "native parent termination";
      const program = viewerProgram.replace(`GetProcessById(${process.pid})`, `GetProcessById(${parent.pid})`);
      const result = await new Promise<number | null>((resolve, reject) => {
        const child = originalSpawn("powershell.exe", ["-NoLogo", "-NoProfile", "-STA", "-Command", program], {
          stdio: ["pipe", "ignore", "ignore"], windowsHide: false,
          env: { NODE_ENV: "development", SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
            PATH: process.env.PATH, TEMP: process.env.TEMP, TMP: process.env.TMP },
        });
        const interrupt = setTimeout(() => parent.kill(), 2000);
        const timeout = setTimeout(() => { child.kill(); reject(new Error("Parent monitor timeout")); }, 15_000);
        const cleanup = () => { clearTimeout(interrupt); clearTimeout(timeout); };
        child.once("error", () => { cleanup(); reject(new Error("Parent monitor unavailable")); });
        child.once("close", code => { cleanup(); resolve(code); });
        child.stdin.on("error", () => child.kill()); child.stdin.end(JSON.stringify(payload));
      });
      assert.equal(result, 2);
      passed++; console.log("PASS: native parent termination closes private disposable viewer");
    } finally { parent.kill(); }
  } finally {
    childProcess.spawn = originalSpawn; syncBuiltinESMExports();
    if (stdinTTY) Object.defineProperty(process.stdin, "isTTY", stdinTTY); else Reflect.deleteProperty(process.stdin, "isTTY");
    if (stdoutTTY) Object.defineProperty(process.stdout, "isTTY", stdoutTTY); else Reflect.deleteProperty(process.stdout, "isTTY");
  }
  console.log(`${passed} automated viewer checks passed; human GUI acceptance NOT performed.`);
}
verify().catch(() => { console.error(`Private viewer verification failed at ${stage}; details withheld.`); process.exitCode = 1; });
