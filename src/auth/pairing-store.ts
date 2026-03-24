/**
 * 设备配对存储
 * 管理已配对设备的持久化状态
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomBytes, createHash } from "node:crypto";

export interface PairedDevice {
  id: string;
  name: string;
  userAgent?: string;
  ipAddress?: string;
  pairedAt: string;
  lastAccessAt: string;
  accessToken: string;
}

export interface PendingPairing {
  code: string;
  createdAt: string;
  expiresAt: string;
}

export interface PairingStore {
  pairedDevices: PairedDevice[];
  pendingPairings: PendingPairing[];
  accessToken: string;
}

const STORE_FILENAME = "control-center-pairing.json";

function getStorePath(): string {
  const openclawHome = process.env.OPENCLAW_HOME || join(homedir(), ".openclaw");
  return join(openclawHome, STORE_FILENAME);
}

function generatePairingCode(): string {
  // 生成 6 位数字配对码
  return randomBytes(3).toString("hex").toUpperCase().slice(0, 6);
}

function generateAccessToken(): string {
  return randomBytes(32).toString("hex");
}

function generateDeviceId(): string {
  return randomBytes(16).toString("hex");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function loadPairingStore(): PairingStore {
  const storePath = getStorePath();
  
  if (!existsSync(storePath)) {
    // 创建新的 store
    const newStore: PairingStore = {
      pairedDevices: [],
      pendingPairings: [],
      accessToken: generateAccessToken(),
    };
    savePairingStore(newStore);
    return newStore;
  }
  
  try {
    const content = readFileSync(storePath, "utf-8");
    return JSON.parse(content);
  } catch {
    // 如果读取失败，创建新的
    const newStore: PairingStore = {
      pairedDevices: [],
      pendingPairings: [],
      accessToken: generateAccessToken(),
    };
    savePairingStore(newStore);
    return newStore;
  }
}

export function savePairingStore(store: PairingStore): void {
  const storePath = getStorePath();
  const dir = dirname(storePath);
  
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  
  writeFileSync(storePath, JSON.stringify(store, null, 2), "utf-8");
}

export function createPairingRequest(): { code: string; expiresAt: string } {
  const store = loadPairingStore();
  const code = generatePairingCode();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000); // 10 分钟过期
  
  store.pendingPairings.push({
    code,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });
  
  // 清理过期的配对请求
  store.pendingPairings = store.pendingPairings.filter(
    p => new Date(p.expiresAt) > now
  );
  
  savePairingStore(store);
  
  return { code, expiresAt: expiresAt.toISOString() };
}

export function completePairing(
  code: string,
  deviceName: string,
  userAgent?: string,
  ipAddress?: string
): { success: boolean; accessToken?: string; error?: string } {
  const store = loadPairingStore();
  const now = new Date();
  
  // 查找配对请求
  const pendingIndex = store.pendingPairings.findIndex(
    p => p.code === code && new Date(p.expiresAt) > now
  );
  
  if (pendingIndex === -1) {
    return { success: false, error: "Invalid or expired pairing code" };
  }
  
  // 移除已使用的配对请求
  store.pendingPairings.splice(pendingIndex, 1);
  
  // 创建新设备
  const accessToken = generateAccessToken();
  const device: PairedDevice = {
    id: generateDeviceId(),
    name: deviceName,
    userAgent,
    ipAddress,
    pairedAt: now.toISOString(),
    lastAccessAt: now.toISOString(),
    accessToken: hashToken(accessToken),
  };
  
  store.pairedDevices.push(device);
  savePairingStore(store);
  
  return { success: true, accessToken };
}

export function validateAccessToken(token: string): { valid: boolean; device?: PairedDevice } {
  const store = loadPairingStore();
  const hashedToken = hashToken(token);
  
  const device = store.pairedDevices.find(d => d.accessToken === hashedToken);
  
  if (device) {
    // 更新最后访问时间
    device.lastAccessAt = new Date().toISOString();
    savePairingStore(store);
    return { valid: true, device };
  }
  
  // 也检查主 access token
  if (token === store.accessToken) {
    return { valid: true };
  }
  
  return { valid: false };
}

export function listPairedDevices(): PairedDevice[] {
  const store = loadPairingStore();
  return store.pairedDevices.map(d => ({
    ...d,
    accessToken: "***", // 不暴露 token
  }));
}

export function revokeDevice(deviceId: string): boolean {
  const store = loadPairingStore();
  const index = store.pairedDevices.findIndex(d => d.id === deviceId);
  
  if (index === -1) {
    return false;
  }
  
  store.pairedDevices.splice(index, 1);
  savePairingStore(store);
  return true;
}

export function getMainAccessToken(): string {
  const store = loadPairingStore();
  return store.accessToken;
}

export function regenerateMainAccessToken(): string {
  const store = loadPairingStore();
  store.accessToken = generateAccessToken();
  savePairingStore(store);
  return store.accessToken;
}
