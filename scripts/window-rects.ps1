# 读取所有带主窗口的 chrome.exe 进程矩形（Left,Top,Right,Bottom）
$code = @'
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, ref RECT r);
}
public struct RECT { public int Left, Top, Right, Bottom; }
'@
Add-Type -TypeDefinition $code

Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object {
  $h = $_.MainWindowHandle
  $rect = New-Object RECT
  [void][W]::GetWindowRect($h, [ref]$rect)
  "$($_.Id):$($rect.Left),$($rect.Top),$($rect.Right),$($rect.Bottom)"
}
