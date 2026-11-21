/** Login startup never creates an account, changes configuration, or starts a legacy installation. */
export async function autoStartConfiguredConnection(actions) {
  let status;
  try { status = await actions.status(); }
  catch { return { attempted: false, error: 'CONNECTOR_STATUS_UNAVAILABLE' }; }
  if (status?.phase !== 'configured' || status.connectionMode !== 'secure' || status.secureError) return { attempted: false };
  try { await actions.connect(); return { attempted: true }; }
  catch (error) {
    return { attempted: true, error: /^SECURE_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'SECURE_START_FAILED' };
  }
}
