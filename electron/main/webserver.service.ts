/**
 * Serveur du portail web embarqué dans l'app (P19).
 *
 * `node:http` lancé en-processus via import dynamique de `server/core.mjs`
 * (pur Node — le même fichier sert au déploiement autonome sur le serveur
 * de la faculté). La base est ouverte par le serveur sur le même fichier
 * `mastertime.db` (WAL — lecture/écriture concurrentes avec l'app OK).
 */
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

interface WebServerState {
  server: http.Server;
  port: number;
}

let state: WebServerState | null = null;

/** IPs IPv4 des interfaces réseau (pour afficher l'URL LAN). */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const i of infos ?? []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

export function webServerStatus(): {
  running: boolean;
  port: number | null;
  urls: string[];
} {
  if (!state) return { running: false, port: null, urls: [] };
  const port = state.port;
  const urls = [
    `http://localhost:${port}`,
    ...lanAddresses().map((ip) => `http://${ip}:${port}`),
  ];
  return { running: true, port: state.port, urls };
}

export async function startWebServer(
  appRoot: string,
  dbPath: string,
  port: number,
): Promise<void> {
  if (state) return;
  const corePath = path.join(appRoot, 'server', 'core.mjs');
  const publicDir = path.join(appRoot, 'web', 'public');
  const mod = (await import(pathToFileURL(corePath).href)) as {
    createHandler: (o: {
      dbPath: string;
      publicDir: string;
    }) => http.RequestListener;
  };
  const handler = mod.createHandler({ dbPath, publicDir });
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve());
  });
  state = { server, port };
}

export async function stopWebServer(): Promise<void> {
  if (!state) return;
  const { server } = state;
  state = null;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
