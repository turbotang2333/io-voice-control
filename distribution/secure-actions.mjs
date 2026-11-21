import { createHostedEnrollment, validateHostedResponse } from './hosted-enrollment.mjs';

const fail = code => Object.assign(Error(code), { code });

/** Keep legacy installations usable while a configured secure identity never falls back to legacy transport. */
export function createSecureDashboardActions({ legacy, secure, hostedRequest, prepareExisting } = {}) {
  const secureSelected = status => status.phase !== 'unconfigured';
  let connecting;
  return {
    async status(force = false) {
      const [base, encrypted] = await Promise.all([legacy.status(force), secure.status()]);
      if (!secureSelected(encrypted)) return { ...base, connectionMode: 'legacy', encryption: 'unverified', hostedEnrollmentAvailable: typeof hostedRequest === 'function' };
      return { ...base, phase: 'configured', connectionMode: 'secure', hosting: encrypted.hosting,
        encryption: encrypted.encryption === 'verified' ? 'verified' : 'unverified', transport: encrypted.transport,
        secureState: encrypted.state, secureError: encrypted.phase === 'configuration_error' ? encrypted.code : undefined,
        ipChangeAvailable: encrypted.ipChangeAvailable === true,
        ipRecoveryOptions: encrypted.ipRecoveryOptions ?? [],
        connections: encrypted.connections ?? [], pairingEnabled: encrypted.phase === 'configured',
        pairingReady: encrypted.encryption === 'verified' && encrypted.pairingReady === true,
        pairingState: encrypted.pairingState ?? 'none' };
    },
    prepare: (...args) => legacy.prepare(...args),
    enrollment: (...args) => legacy.enrollment(...args),
    async invitation(value) {
      if ([2, 3].includes(value?.version)) return secure.configure(value);
      if (secureSelected(await secure.status())) throw fail('SECURE_CONFIGURATION_EXISTS');
      return legacy.invitation(value);
    },
    connect(options = {}) {
      return connecting ??= (async () => {
        const { invitationCode, ...connectionOptions } = options;
        if (secureSelected(await secure.status())) return secure.connect(connectionOptions);
        if (options?.hosting === 'project-hosted' && typeof hostedRequest === 'function' && typeof prepareExisting === 'function'
          && (await legacy.status()).phase === 'existing') {
          const enrollment = createHostedEnrollment(await prepareExisting());
          const response = validateHostedResponse(await hostedRequest(enrollment, invitationCode), enrollment);
          if (secureSelected(await secure.status())) throw fail('SECURE_CONFIGURATION_EXISTS');
          await secure.configure(response);
          return secure.connect(connectionOptions);
        }
        const result = await legacy.connect(connectionOptions);
        if (!result?.needsConfiguration || options?.hosting !== 'project-hosted' || typeof hostedRequest !== 'function') return result;
        const enrollment = createHostedEnrollment(await legacy.enrollment());
        const response = validateHostedResponse(await hostedRequest(enrollment, invitationCode), enrollment);
        if (secureSelected(await secure.status())) throw fail('SECURE_CONFIGURATION_EXISTS');
        await secure.configure(response);
        return secure.connect(connectionOptions);
      })().finally(() => { connecting = undefined; });
    },
    async pair(...args) {
      return secureSelected(await secure.status()) ? secure.pair(...args) : legacy.pair(...args);
    },
  };
}
