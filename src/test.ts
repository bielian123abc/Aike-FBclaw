// Quick test script
import { FbClawApp } from './index.js';

console.log('Aike-FBclaw Test');
console.log('------------------');

const app = new FbClawApp();

app.initialize().then((r: any) => {
  console.log('Initialize:', r.message);
  
  // Check AdsPower
  return app.adspower.checkConnection().then((connected: boolean) => {
    console.log('AdsPower API:', connected ? 'CONNECTED' : 'NOT CONNECTED');
    console.log('System ready!');
    
    if (connected) {
      return app.adspower.listProfiles({ page: 1, pageSize: 5 }).then((profiles: any) => {
        console.log('Profiles found:', profiles.list?.length || 0);
        if (profiles.list) {
          profiles.list.slice(0, 3).forEach((p: any) => {
            console.log(`  - [${p.user_id}] ${p.name} (${p.ip_country || '?'})`);
          });
        }
      }).catch((e: any) => console.log('List profiles error:', e.message));
    }
  });
}).catch((e: any) => {
  console.error('FATAL:', e.message);
  console.error(e.stack);
});
