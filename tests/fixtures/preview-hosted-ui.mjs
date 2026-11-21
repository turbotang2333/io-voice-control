// Local UI preview only: no relay, assistant, user configuration, or external network.
import { createServer } from 'node:http';
import { createDashboardHandler } from '../../distribution/dashboard.mjs';
const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('invalid port');
let phase = 'new';
const actions = {
  status() { return { preview: true, phase, available: ['paseo', 'codex'], hostedEnrollmentAvailable: true,
    enrollmentAvailable: phase !== 'new', connections: [], pairingEnabled: false, pairingReady: false }; },
  connect(value) { if (value.hosting === 'self-hosted') { phase = 'prepared'; return { needsConfiguration: true }; }
    phase = 'configured'; return { starting: true }; },
  enrollment() { return { version: 1, preview: true }; },
};
const origin = `http://127.0.0.1:${port}`, server = createServer(createDashboardHandler({ actions, getOrigin: () => origin }));
server.listen(port, '127.0.0.1', () => console.log('PREVIEW_READY'));
process.once('SIGINT', () => server.close()); process.once('SIGTERM', () => server.close());
