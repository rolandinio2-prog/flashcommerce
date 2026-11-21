// Forwards the localhost ports that the staging browser bundle expects to the staging containers,
// then runs Playwright. Exit code = Playwright's.
import net from 'node:net';
import { spawn } from 'node:child_process';

const routes = { 13000: ['172.30.80.4', 3000], 13001: ['172.30.80.3', 3001], 13002: ['172.30.80.5', 3000],
                 18000: ['172.30.80.7', 8000], 15433: ['172.30.80.2', 5432] };
const servers = Object.entries(routes).map(([port, [host, target]]) =>
  net.createServer(c => { const u = net.connect(target, host); c.pipe(u).pipe(c); u.on('error', () => c.destroy()); c.on('error', () => u.destroy()); })
    .listen(Number(port), '127.0.0.1'));
await new Promise(r => setTimeout(r, 300));
const child = spawn('npx', ['playwright', 'test', ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('exit', code => { servers.forEach(s => s.close()); process.exit(code ?? 1); });
