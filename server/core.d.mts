// Déclarations TS pour core.mjs (serveur web autonome, JS pur).
import type { Server } from 'node:http';

export function hashPassword(password: string): string;
export function verifyPassword(password: string, stored: string): boolean;
export function createHandler(opts: {
  dbPath: string;
  publicDir?: string;
}): (
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
) => void;
export function startServer(opts: {
  dbPath: string;
  publicDir?: string;
  port?: number;
  host?: string;
}): Promise<Server>;
