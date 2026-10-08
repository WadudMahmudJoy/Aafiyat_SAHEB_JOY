import { spawn } from "node:child_process";

// Local Windows dialog only: secret travels through an anonymous stdin pipe,
// never command arguments, stdout/stderr, clipboard, browser, URL, or disk.
export async function showLocalEnrollmentUri(uri: string) {
  const parsed = new URL(uri);
  if (process.platform !== "win32" || !process.stdin.isTTY || !process.stdout.isTTY ||
      parsed.protocol !== "otpauth:" || parsed.hostname !== "totp") throw new Error("Local interactive Windows terminal required.");
  const program = `
    $ErrorActionPreference = 'Stop'
    Add-Type -AssemblyName System.Windows.Forms
    $operatorProcess = [System.Diagnostics.Process]::GetProcessById(${process.pid})
    $enrollmentUri = [Console]::In.ReadToEnd()
    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'Aafiyat local authenticator enrollment'
    $form.Width = 780; $form.Height = 310; $form.StartPosition = 'CenterScreen'
    $label = New-Object System.Windows.Forms.Label
    $label.Text = 'Private enrollment URI. Add it to your authenticator, then select Done. Closing cancels.'
    $label.Left = 20; $label.Top = 20; $label.Width = 720; $label.Height = 45
    $box = New-Object System.Windows.Forms.TextBox
    $box.Text = $enrollmentUri; $box.ReadOnly = $true; $box.Multiline = $true
    $box.ShortcutsEnabled = $false; $box.Left = 20; $box.Top = 75; $box.Width = 720; $box.Height = 110
    $box.ScrollBars = 'Vertical'; $box.ContextMenuStrip = New-Object System.Windows.Forms.ContextMenuStrip
    $done = New-Object System.Windows.Forms.Button
    $done.Text = 'Done'; $done.Left = 620; $done.Top = 205; $done.DialogResult = 'OK'
    $form.Controls.Add($label); $form.Controls.Add($box)
    $form.Controls.Add($done)
    $timer = New-Object System.Windows.Forms.Timer
    $deadline = [DateTime]::UtcNow.AddSeconds(120)
    $timer.Interval = 500
    $timer.Add_Tick({
      if ($operatorProcess.HasExited -or [DateTime]::UtcNow -ge $deadline) { $form.Close() }
    })
    $timer.Start()
    $completed = $false
    try { $completed = $form.ShowDialog() -eq 'OK' } finally {
      $box.Text = ''; $enrollmentUri = ''; $timer.Dispose()
      $box.ContextMenuStrip.Dispose(); $form.Dispose(); $operatorProcess.Dispose()
    }
    if (-not $completed) { exit 2 }
  `;
  await new Promise<void>((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-STA", "-Command", program], {
      stdio: ["pipe", "ignore", "ignore"], windowsHide: true,
      // The viewer needs no database URL, application secret, or other inherited credentials.
      env: { NODE_ENV: "development", SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
        PATH: process.env.PATH, TEMP: process.env.TEMP, TMP: process.env.TMP },
    });
    let cancelled = false;
    const terminate = () => { child.kill(); };
    const cancel = () => { cancelled = true; terminate(); };
    process.once("exit", terminate);
    process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
    const cleanup = () => {
      clearTimeout(timeout); process.off("exit", terminate);
      process.off("SIGINT", cancel); process.off("SIGTERM", cancel);
    };
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Local enrollment display expired.")); }, 130_000);
    child.once("error", () => { cleanup(); reject(new Error("Local enrollment display unavailable.")); });
    child.once("exit", code => {
      cleanup();
      if (code === 0 && !cancelled) resolve(); else reject(new Error("Local enrollment display failed."));
    });
    child.stdin.on("error", () => { child.kill(); });
    child.stdin.end(uri);
  });
}
