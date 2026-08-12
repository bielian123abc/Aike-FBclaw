/**
 * 建立桌面捷徑 Aike-FBclaw.lnk
 * 指向 Aike-FBclaw.ps1（隱藏 PowerShell 視窗啟動 Electron）。
 * 路徑透過環境變數傳入，避免 PowerShell 引號/反斜線轉義問題。
 */
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.resolve(__dirname, '..');
const ps1 = path.join(root, 'Aike-FBclaw.ps1');
const icon = path.join(root, 'assets', 'icon.ico');
const desktop = process.env.USERPROFILE + '\\Desktop';
const lnk = path.join(desktop, 'Aike-FBclaw.lnk');

const ps = `
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($env:LNK_PATH)
$sc.TargetPath = 'powershell.exe'
$sc.Arguments = '-WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $env:PS1_PATH + '"'
$sc.WorkingDirectory = $env:ROOT_PATH
$sc.IconLocation = $env:ICON_PATH
$sc.Description = 'Aike-FBclaw'
$sc.WindowStyle = 1
$sc.Save()
`;
const tmp = path.join(root, 'scripts', '_mklnk.ps1');
fs.writeFileSync(tmp, ps);
try {
  execSync('powershell -NoProfile -ExecutionPolicy Bypass -File "' + tmp + '"', {
    stdio: 'inherit',
    env: { ...process.env, LNK_PATH: lnk, PS1_PATH: ps1, ICON_PATH: icon, ROOT_PATH: root },
  });
  console.log('桌面捷徑已建立：', lnk);
} catch (e) {
  console.error('建立捷徑失敗：', e.message);
  process.exitCode = 1;
} finally {
  try { fs.unlinkSync(tmp); } catch {}
}
