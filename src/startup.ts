/**
 * Aike-FBclaw 独立启动脚本
 * 不依赖 Electron，直接运行核心引擎
 * 
 * 使用方式: node dist/startup.js
 * 或: npx tsx src/startup.ts
 */

import { FbClawApp } from './index';
import { autoImport } from './utils/account-importer';
import * as readline from 'readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

async function mainMenu(app: FbClawApp): Promise<void> {
  console.clear();
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   Aike-FBclaw — FB 多账号 AI 运营系统   ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  console.log('  1. 导入账号（Excel/CSV/JSON）');
  console.log('  2. 检查 AdsPower 连接');
  console.log('  3. 查看 AdsPower Profile 列表');
  console.log('  4. 启动指定账号');
  console.log('  5. 查看账号状态');
  console.log('  6. 给账号添加任务');
  console.log('  7. 广播任务到所有账号');
  console.log('  8. 查看全局统计');
  console.log('  9. 停止所有账号');
  console.log('  0. 退出');
  console.log('');

  rl.question('请选择: ', async (choice) => {
    switch (choice) {
      case '1': {
        rl.question('文件路径: ', async (filePath) => {
          rl.question('分组名称（可选）: ', async (groupName) => {
            console.log('\n正在导入...');
            const result = autoImport(filePath, groupName || undefined);
            console.log(`\n导入完成: ${result.success.length} 成功, ${result.failed.length} 失败 (共 ${result.total} 条)`);
            
            if (result.success.length > 0) {
              console.log('\n成功导入的账号:');
              result.success.forEach((a, i) => {
                console.log(`  ${i + 1}. ${a.name} (${a.username})`);
              });

              rl.question('\n是否立即注册这些账号？(y/n): ', async (answer) => {
                if (answer.toLowerCase() === 'y') {
                  const { success, failed } = await app.registerAccounts(result.success);
                  console.log(`注册完成: ${success} 成功, ${failed} 失败`);
                }
                pressAnyKey();
              });
            } else {
              result.failed.forEach(f => console.log(`  ❌ 第${f.row}行: ${f.reason}`));
              pressAnyKey();
            }
          });
        });
        break;
      }
      case '2': {
        console.log('\n正在检查 AdsPower 连接...');
        const connected = await app.adspower.checkConnection();
        console.log(connected ? '✅ AdsPower 已连接' : '❌ AdsPower 未连接，请确保 AdsPower 正在运行');
        pressAnyKey();
        break;
      }
      case '3': {
        console.log('\n正在获取 Profile 列表...');
        try {
          const profiles = await app.adspower.getAllProfiles();
          console.log(`找到 ${profiles.length} 个 Profile:\n`);
          profiles.slice(0, 20).forEach((p, i) => {
            console.log(`  ${i + 1}. [${p.user_id}] ${p.name} | ${p.ip_country || '未知'} | ${p.domain_name || '-'}`);
          });
          if (profiles.length > 20) {
            console.log(`  ... 还有 ${profiles.length - 20} 个`);
          }
        } catch (error: any) {
          console.log(`❌ 获取失败: ${error.message}`);
        }
        pressAnyKey();
        break;
      }
      case '4': {
        rl.question('Profile ID: ', async (profileId) => {
          rl.question('账号名称: ', async (name) => {
            rl.question('邮箱/用户名: ', async (username) => {
              const accountId = `acc_${profileId}`;
              try {
                const agent = await app.registerAccount({
                  accountId,
                  name: name || `User_${profileId}`,
                  adsPowerProfileId: profileId,
                  username: username || undefined,
                });
                console.log(`\n✅ 账号 ${name} 已注册并启动`);
                console.log(JSON.stringify(agent.getState(), null, 2));
              } catch (error: any) {
                console.log(`❌ 失败: ${error.message}`);
              }
              pressAnyKey();
            });
          });
        });
        break;
      }
      case '5': {
        const states = app.orchestrator?.getAllStates() || [];
        if (states.length === 0) {
          console.log('\n暂无已注册的账号');
        } else {
          console.log('\n账号状态列表:\n');
          states.forEach((s, i) => {
            const statusIcon = s.status === 'idle' ? '🟢' : s.status === 'running' ? '🔵' : s.status === 'error' ? '🔴' : '⚪';
            console.log(`  ${statusIcon} ${s.config?.name} | ${s.status} | ${s.currentPageType} | ${s.config?.proxyIp || '-'}`);
          });
        }
        pressAnyKey();
        break;
      }
      case '6': {
        rl.question('账号ID: ', async (accountId) => {
          rl.question('任务类型 (browse_feed/like_post/share_post/add_friends/join_groups): ', async (taskType) => {
            const agent = app.accounts.get(accountId);
            if (!agent) {
              console.log('❌ 账号不存在');
            } else {
              agent.addTask({
                id: `${taskType}-${Date.now()}`,
                type: taskType as any,
                priority: 3,
                params: {},
                status: 'pending',
              });
              console.log('✅ 任务已添加');
            }
            pressAnyKey();
          });
        });
        break;
      }
      case '7': {
        rl.question('任务类型: ', async (taskType) => {
          if (app.orchestrator) {
            const result = app.orchestrator.broadcastTask({
              id: `broadcast-${Date.now()}`,
              type: taskType as any,
              priority: 3,
              params: {},
              status: 'pending',
            });
            console.log(`\n广播完成: ${result.success} 成功, ${result.failed} 失败`);
          }
          pressAnyKey();
        });
        break;
      }
      case '8': {
        const stats = app.orchestrator?.getGlobalStats();
        if (stats) {
          console.log('\n全局统计:');
          console.log(JSON.stringify(stats, null, 2));
        }
        pressAnyKey();
        break;
      }
      case '9': {
        rl.question('确认停止所有账号？(y/n): ', async (answer) => {
          if (answer.toLowerCase() === 'y') {
            await app.shutdown();
            console.log('✅ 所有账号已停止');
          }
          pressAnyKey();
        });
        break;
      }
      case '0': {
        console.log('\n正在关闭...');
        await app.shutdown();
        rl.close();
        process.exit(0);
        return;
      }
      default: {
        pressAnyKey();
        return;
      }
    }
  });
}

function pressAnyKey(): void {
  console.log('');
  rl.question('按 Enter 返回主菜单...', () => {
    mainMenu(getApp());
  });
}

// 动态引入避免循环依赖
let appInstance: FbClawApp | null = null;

function getApp(): FbClawApp {
  if (!appInstance) {
    appInstance = new FbClawApp();
  }
  return appInstance;
}

// 启动
async function start(): Promise<void> {
  console.log('正在初始化 Aike-FBclaw...');
  
  const app = getApp();
  const initResult = await app.initialize();
  
  console.log(initResult.message);
  console.log('');

  // 检查 AdsPower
  const connected = await app.adspower.checkConnection();
  if (!connected) {
    console.log('⚠️  AdsPower 未连接。部分功能将不可用。');
    console.log('   请确保 AdsPower 正在运行，且 API 端口为 50325。');
    console.log('');
  }

  await mainMenu(app);
}

start().catch(console.error);
