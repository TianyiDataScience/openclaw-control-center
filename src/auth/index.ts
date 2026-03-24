/**
 * 配对认证模块导出
 */

export {
  loadPairingStore,
  savePairingStore,
  createPairingRequest,
  completePairing,
  validateAccessToken,
  listPairedDevices,
  revokeDevice,
  getMainAccessToken,
  regenerateMainAccessToken,
  type PairedDevice,
  type PendingPairing,
  type PairingStore,
} from "./pairing-store";

export {
  handlePairingRoutes,
  authenticateRequest,
  requiresAuth,
  type AuthResult,
} from "./pairing-middleware";
