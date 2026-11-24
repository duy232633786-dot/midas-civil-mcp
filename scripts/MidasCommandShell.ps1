param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Inspect', 'Stage', 'Run', 'Close')]
  [string]$Action,

  [int]$TargetProcessId = 0,
  [string]$MctFile = '',
  [string]$ExpectedSha256 = '',
  [string]$ExpectedWindowTitle = ''
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class MidasCommandShellNative {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr hWnd, EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr hWnd, int id);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
  [DllImport("user32.dll", EntryPoint = "SendMessageW")] private static extern IntPtr SendMessageRaw(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageW")] private static extern IntPtr SendMessageText(IntPtr hWnd, uint message, IntPtr wParam, string text);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageW")] private static extern IntPtr SendMessageBuffer(IntPtr hWnd, uint message, IntPtr wParam, StringBuilder text);

  public static IntPtr FindTopLevel(int processId, string exactTitle) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
      uint candidateProcessId;
      GetWindowThreadProcessId(hWnd, out candidateProcessId);
      if (candidateProcessId != (uint)processId) return true;
      if (exactTitle != null) {
        StringBuilder title = new StringBuilder(512);
        GetWindowText(hWnd, title, title.Capacity);
        if (!String.Equals(title.ToString(), exactTitle, StringComparison.Ordinal)) return true;
      }
      found = hWnd;
      return false;
    }, IntPtr.Zero);
    return found;
  }

  public static IntPtr FindChildClassPrefix(IntPtr parent, string prefix) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(parent, delegate(IntPtr hWnd, IntPtr lParam) {
      StringBuilder className = new StringBuilder(256);
      GetClassName(hWnd, className, className.Capacity);
      if (className.ToString().StartsWith(prefix, StringComparison.Ordinal)) {
        found = hWnd;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static string WindowText(IntPtr hWnd) {
    StringBuilder text = new StringBuilder(1024);
    GetWindowText(hWnd, text, text.Capacity);
    return text.ToString();
  }

  public static void ClickAt(IntPtr hWnd, int x, int y) {
    IntPtr packed = new IntPtr((y << 16) | (x & 0xffff));
    SendMessageRaw(hWnd, 0x0201, new IntPtr(1), packed);
    SendMessageRaw(hWnd, 0x0202, IntPtr.Zero, packed);
  }

  public static void ClickButton(IntPtr hWnd) {
    SendMessageRaw(hWnd, 0x00F5, IntPtr.Zero, IntPtr.Zero);
  }

  public static void SetControlText(IntPtr hWnd, string text) {
    SendMessageText(hWnd, 0x000C, IntPtr.Zero, text);
  }

  public static string GetControlText(IntPtr hWnd) {
    int length = SendMessageRaw(hWnd, 0x000E, IntPtr.Zero, IntPtr.Zero).ToInt32();
    StringBuilder text = new StringBuilder(length + 2);
    SendMessageBuffer(hWnd, 0x000D, new IntPtr(text.Capacity), text);
    return text.ToString();
  }
}
'@

function Get-CanonicalHash([string]$Value) {
  $canonical = $Value.Replace("`r`n", "`n").Replace("`r", "`n")
  if (-not $canonical.EndsWith("`n")) { $canonical += "`n" }
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($canonical)
    return ([System.BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
  }
}

function Get-TargetProcess {
  if ($TargetProcessId -le 0) { throw 'TargetProcessId must be a positive CVLw process ID.' }
  $targetProcess = Get-Process -Id $TargetProcessId -ErrorAction Stop
  if ($targetProcess.ProcessName -ne 'CVLw') { throw 'TargetProcessId is not a CVLw process.' }
  $targetProcess.Refresh()
  if ($targetProcess.MainWindowHandle -eq [IntPtr]::Zero) { throw 'MIDAS main window is not available.' }
  return $targetProcess
}

function Find-MctDialog {
  return [MidasCommandShellNative]::FindTopLevel($TargetProcessId, 'MCT Command Shell')
}

if ($Action -eq 'Inspect') {
  $windows = foreach ($targetProcess in @(Get-Process -Name CVLw -ErrorAction SilentlyContinue)) {
    $targetProcess.Refresh()
    [pscustomobject]@{
      processId = $targetProcess.Id
      windowTitle = $targetProcess.MainWindowTitle
      mainWindowAvailable = $targetProcess.MainWindowHandle -ne [IntPtr]::Zero
      commandShellOpen = [MidasCommandShellNative]::FindTopLevel($targetProcess.Id, 'MCT Command Shell') -ne [IntPtr]::Zero
    }
  }
  [pscustomobject]@{ windows = @($windows) } | ConvertTo-Json -Depth 4 -Compress
  exit 0
}

$process = Get-TargetProcess
$windowTitle = $process.MainWindowTitle

if ($Action -eq 'Stage') {
  if (-not (Test-Path -LiteralPath $MctFile -PathType Leaf)) { throw 'MCT file does not exist.' }
  if ($ExpectedSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'ExpectedSha256 is invalid.' }
  $content = [System.IO.File]::ReadAllText($MctFile, [System.Text.Encoding]::UTF8)
  $actualHash = Get-CanonicalHash $content
  if ($actualHash -ne $ExpectedSha256.ToLowerInvariant()) { throw 'MCT file hash does not match the confirmed preview.' }

  $dialog = Find-MctDialog
  if ($dialog -eq [IntPtr]::Zero) {
    [void][MidasCommandShellNative]::ShowWindowAsync($process.MainWindowHandle, 9)
    $ribbon = [MidasCommandShellNative]::FindChildClassPrefix($process.MainWindowHandle, 'BCGPRibbonBar')
    if ($ribbon -eq [IntPtr]::Zero) { throw 'MIDAS ribbon was not found.' }
    [MidasCommandShellNative]::ClickAt($ribbon, 970, 48)
    Start-Sleep -Milliseconds 350
    [MidasCommandShellNative]::ClickAt($ribbon, 174, 90)
    for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
      Start-Sleep -Milliseconds 250
      $dialog = Find-MctDialog
      if ($dialog -ne [IntPtr]::Zero) { break }
    }
  }
  if ($dialog -eq [IntPtr]::Zero) { throw 'MCT Command Shell did not open.' }
  $editor = [MidasCommandShellNative]::GetDlgItem($dialog, 4962)
  if ($editor -eq [IntPtr]::Zero) { throw 'MCT editor control was not found.' }
  [MidasCommandShellNative]::SetControlText($editor, $content)
  $stagedText = [MidasCommandShellNative]::GetControlText($editor)
  $stagedHash = Get-CanonicalHash $stagedText
  if ($stagedHash -ne $ExpectedSha256.ToLowerInvariant()) { throw 'Text changed while staging; Run was not pressed.' }
  [pscustomobject]@{
    staged = $true
    processId = $TargetProcessId
    windowTitle = $windowTitle
    sha256 = $stagedHash
    characters = $stagedText.Length
    runPressed = $false
  } | ConvertTo-Json -Depth 3 -Compress
  exit 0
}

if ($ExpectedWindowTitle -ne $windowTitle) { throw 'MIDAS target window title changed after staging.' }
$dialog = Find-MctDialog
if ($dialog -eq [IntPtr]::Zero) { throw 'MCT Command Shell is not open.' }

if ($Action -eq 'Run') {
  if ($ExpectedSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'ExpectedSha256 is invalid.' }
  $editor = [MidasCommandShellNative]::GetDlgItem($dialog, 4962)
  $currentHash = Get-CanonicalHash ([MidasCommandShellNative]::GetControlText($editor))
  if ($currentHash -ne $ExpectedSha256.ToLowerInvariant()) { throw 'Staged MCT content changed; Run was not pressed.' }
  $runButton = [MidasCommandShellNative]::GetDlgItem($dialog, 4909)
  if ($runButton -eq [IntPtr]::Zero) { throw 'Run button was not found.' }
  [MidasCommandShellNative]::ClickButton($runButton)
  [pscustomobject]@{
    runPressed = $true
    processId = $TargetProcessId
    windowTitle = $windowTitle
    sha256 = $currentHash
  } | ConvertTo-Json -Depth 3 -Compress
  exit 0
}

if ($Action -eq 'Close') {
  $closeButton = [MidasCommandShellNative]::GetDlgItem($dialog, 8)
  if ($closeButton -eq [IntPtr]::Zero) { throw 'Close button was not found.' }
  [MidasCommandShellNative]::ClickButton($closeButton)
  [pscustomobject]@{ closed = $true; processId = $TargetProcessId; windowTitle = $windowTitle } | ConvertTo-Json -Depth 3 -Compress
}
