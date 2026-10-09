import { spawn } from "node:child_process";
import encodeQR from "qr";

export class LocalEnrollmentDisplayError extends Error {
  constructor(public readonly reason: "cancelled" | "expired" | "unavailable" | "failed") {
    super(`Local enrollment display ${reason}.`);
  }
}

// Sensitive return value: local stdin transport only, never a public DTO or log.
export function buildLocalEnrollmentDisplay(uri: string) {
  let parsed: URL;
  try { parsed = new URL(uri); } catch { throw new LocalEnrollmentDisplayError("unavailable"); }
  const manualKey = parsed.searchParams.get("secret") ?? "";
  if (uri.length > 8192 || parsed.protocol !== "otpauth:" || parsed.hostname !== "totp" ||
      !/^[A-Z2-7]{16,256}={0,6}$/i.test(manualKey)) throw new LocalEnrollmentDisplayError("unavailable");
  let label: string;
  try { label = decodeURIComponent(parsed.pathname.slice(1)); }
  catch { throw new LocalEnrollmentDisplayError("unavailable"); }
  const separator = label.indexOf(":");
  const issuer = parsed.searchParams.get("issuer") || (separator >= 0 ? label.slice(0, separator) : "TOTP");
  const accountLabel = separator >= 0 ? label.slice(separator + 1) : label;
  const algorithm = (parsed.searchParams.get("algorithm") || "SHA1").toUpperCase();
  const digits = Number(parsed.searchParams.get("digits") || 6);
  const period = Number(parsed.searchParams.get("period") || 30);
  if (!accountLabel || !["SHA1", "SHA256", "SHA512"].includes(algorithm) ||
      ![6, 8].includes(digits) || !Number.isInteger(period) || period < 1 || period > 300) {
    throw new LocalEnrollmentDisplayError("unavailable");
  }
  let qrGifBase64 = "";
  try { qrGifBase64 = Buffer.from(encodeQR(uri, "gif", { scale: 6, border: 4, ecc: "medium" })).toString("base64"); }
  catch { /* Manual setup remains available without revealing encoder errors. */ }
  return { issuer, accountLabel, manualKey, algorithm, digits, period, qrGifBase64 };
}

// Local Windows dialog only: secret travels through an anonymous stdin pipe,
// never command arguments, stdout/stderr, clipboard, browser, URL, or disk.
export async function showLocalEnrollmentUri(uri: string) {
  if (process.platform !== "win32" || !process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Local interactive Windows terminal required.");
  }
  const payload = buildLocalEnrollmentDisplay(uri);
  const program = `
    $ErrorActionPreference = 'Stop'
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $operatorProcess = [System.Diagnostics.Process]::GetProcessById(${process.pid})
    $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'Aafiyat local authenticator enrollment'
    $form.AutoScaleDimensions = New-Object System.Drawing.SizeF(96, 96)
    $form.AutoScaleMode = 'Dpi'
    $form.ClientSize = New-Object System.Drawing.Size(620, 760)
    $form.MinimumSize = New-Object System.Drawing.Size(640, 540)
    $workingArea = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $form.Height = [Math]::Min($form.Height, $workingArea.Height - 60)
    $form.StartPosition = 'CenterScreen'; $form.AutoScroll = $true
    $form.ShowInTaskbar = $true; $form.TopMost = $true
    $form.Add_Shown({
      $form.Activate(); $form.BringToFront(); $done.Select()
      $form.TopMost = $false
    })
    $label = New-Object System.Windows.Forms.Label
    $label.Text = 'Scan this private QR in your authenticator, or reveal the manual key. Do not capture or share it.'
    $label.SetBounds(20, 15, 580, 40)
    $identity = New-Object System.Windows.Forms.Label
    $identity.Text = 'Issuer: ' + $payload.issuer + [Environment]::NewLine + 'Account: ' + $payload.accountLabel
    $identity.SetBounds(20, 60, 580, 55); $identity.AutoEllipsis = $true
    $picture = New-Object System.Windows.Forms.PictureBox
    $picture.SetBounds(100, 120, 420, 420); $picture.SizeMode = 'Zoom'; $picture.BackColor = 'White'
    $qrStatus = New-Object System.Windows.Forms.Label
    $qrStatus.Text = 'QR unavailable. Use the manual setup key below.'
    $qrStatus.SetBounds(100, 260, 420, 60)
    $image = $null; $imageStream = $null; $imageBytes = $null
    try {
      if (-not $payload.qrGifBase64) { throw 'QR unavailable' }
      $imageBytes = [Convert]::FromBase64String($payload.qrGifBase64)
      $imageStream = New-Object System.IO.MemoryStream(,$imageBytes)
      $image = [System.Drawing.Image]::FromStream($imageStream)
      $picture.Image = $image; $qrStatus.Visible = $false
    } catch { $picture.Visible = $false }
    $manualLabel = New-Object System.Windows.Forms.Label
    $manualLabel.Text = 'Manual setup key (private; hidden initially)'
    $manualLabel.SetBounds(20, 555, 440, 25)
    $box = New-Object System.Windows.Forms.TextBox
    $box.Text = ''; $box.ReadOnly = $true; $box.Multiline = $true
    $box.Font = New-Object System.Drawing.Font('Consolas', 14)
    $box.ShortcutsEnabled = $false; $box.SetBounds(20, 585, 580, 65)
    $box.ScrollBars = 'Vertical'; $box.ContextMenuStrip = New-Object System.Windows.Forms.ContextMenuStrip
    $reveal = New-Object System.Windows.Forms.Button
    $reveal.Text = 'Show key'; $reveal.SetBounds(480, 550, 120, 30)
    $reveal.Add_Click({
      if ($box.Text.Length -eq 0) { $box.Text = $payload.manualKey; $reveal.Text = 'Hide key' }
      else { $box.Text = ''; $reveal.Text = 'Show key' }
    })
    $settings = New-Object System.Windows.Forms.Label
    $settings.Text = 'Time-based / ' + $payload.algorithm + ' / ' + $payload.digits + ' digits / ' + $payload.period + ' seconds'
    $settings.SetBounds(20, 655, 580, 25)
    $done = New-Object System.Windows.Forms.Button
    $done.Text = 'Done'; $done.SetBounds(480, 700, 120, 35); $done.DialogResult = 'OK'
    $cancelButton = New-Object System.Windows.Forms.Button
    $cancelButton.Text = 'Cancel'; $cancelButton.SetBounds(340, 700, 120, 35); $cancelButton.DialogResult = 'Cancel'
    $form.CancelButton = $cancelButton
    $form.Controls.AddRange(@($label, $identity, $picture, $qrStatus, $manualLabel, $box, $reveal, $settings, $done, $cancelButton))
    $timer = New-Object System.Windows.Forms.Timer
    $deadline = [DateTime]::UtcNow.AddSeconds(120)
    $timer.Interval = 500
    $timer.Add_Tick({
      if ($operatorProcess.HasExited -or [DateTime]::UtcNow -ge $deadline) { $form.Close() }
    })
    $timer.Start()
    $completed = $false
    try { $completed = $form.ShowDialog() -eq 'OK' } finally {
      $box.Text = ''; $payload.manualKey = ''; $payload.qrGifBase64 = ''; $timer.Dispose()
      $picture.Image = $null
      if ($image) { $image.Dispose() }; if ($imageStream) { $imageStream.Dispose() }
      if ($imageBytes) { [Array]::Clear($imageBytes, 0, $imageBytes.Length) }
      $box.ContextMenuStrip.Dispose(); $box.Font.Dispose(); $form.Dispose(); $operatorProcess.Dispose()
    }
    if (-not $completed) { exit 2 }
  `;
  await new Promise<void>((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-STA", "-Command", program], {
      // This child intentionally displays an interactive form; hidden startup can suppress it.
      stdio: ["pipe", "ignore", "ignore"], windowsHide: false,
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
    const timeout = setTimeout(() => { child.kill(); reject(new LocalEnrollmentDisplayError("expired")); }, 130_000);
    child.once("error", () => { cleanup(); reject(new LocalEnrollmentDisplayError("unavailable")); });
    child.once("exit", code => {
      cleanup();
      if (code === 0 && !cancelled) resolve();
      else reject(new LocalEnrollmentDisplayError(cancelled || code === 2 ? "cancelled" : "failed"));
    });
    child.stdin.on("error", () => { child.kill(); });
    child.stdin.end(JSON.stringify(payload));
  });
}
