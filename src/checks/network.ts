import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as tls from "node:tls";
import * as dns from "node:dns/promises";
import type { CheckFn, CheckResult } from "../types.js";

export function httpCheck(
  url: string,
  options: { expectedStatus?: number; timeout?: number } = {},
): CheckFn {
  const expectedStatus = options.expectedStatus ?? 200;
  const timeoutMs = (options.timeout ?? 10) * 1000;

  return (): Promise<CheckResult> =>
    new Promise((resolve) => {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        resolve({ status: "fail", message: `Invalid URL: ${url}` });
        return;
      }

      const lib = parsed.protocol === "https:" ? https : http;
      const req = lib.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || undefined,
          path: parsed.pathname + parsed.search,
          method: "HEAD",
          timeout: timeoutMs,
        },
        (res) => {
          res.resume();
          if (res.statusCode === expectedStatus) {
            resolve({ status: "ok", message: `HTTP ${res.statusCode}` });
          } else {
            resolve({
              status: "fail",
              message: `HTTP ${res.statusCode} (expected ${expectedStatus})`,
              hint: `URL: ${url}`,
            });
          }
        },
      );

      req.on("timeout", () => {
        req.destroy();
        resolve({
          status: "fail",
          message: `Connection timed out after ${options.timeout ?? 10}s`,
          hint: `URL: ${url}`,
        });
      });

      req.on("error", (err) => {
        resolve({
          status: "fail",
          message: err.message,
          hint: `Check that ${url} is accessible`,
        });
      });

      req.end();
    });
}

export function tcpCheck(
  host: string,
  port: number,
  options: { timeout?: number } = {},
): CheckFn {
  const timeoutMs = (options.timeout ?? 5) * 1000;

  return (): Promise<CheckResult> =>
    new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(timeoutMs);

      socket.connect(port, host, () => {
        socket.destroy();
        resolve({ status: "ok", message: `${host}:${port} reachable` });
      });

      socket.on("timeout", () => {
        socket.destroy();
        resolve({
          status: "fail",
          message: `${host}:${port} timed out after ${options.timeout ?? 5}s`,
        });
      });

      socket.on("error", (err) => {
        resolve({
          status: "fail",
          message: `${host}:${port} unreachable: ${err.message}`,
          hint: `Ensure the service is running on ${host}:${port}`,
        });
      });
    });
}

export function dnsCheck(hostname: string): CheckFn {
  return async (): Promise<CheckResult> => {
    try {
      await dns.lookup(hostname);
      return { status: "ok", message: `${hostname} resolved` };
    } catch (err: unknown) {
      return {
        status: "fail",
        message: `DNS lookup failed for ${hostname}: ${err instanceof Error ? err.message : String(err)}`,
        hint: "Check your DNS configuration or network connectivity",
      };
    }
  };
}

export function sslCertCheck(
  hostname: string,
  options: { port?: number; minDaysRemaining?: number } = {},
): CheckFn {
  const port = options.port ?? 443;
  const minDaysRemaining = options.minDaysRemaining ?? 14;

  return (): Promise<CheckResult> =>
    new Promise((resolve) => {
      const socket = tls.connect(
        { host: hostname, port, servername: hostname, timeout: 10000 },
        () => {
          const cert = socket.getPeerCertificate();
          socket.destroy();

          if (!cert || Object.keys(cert).length === 0) {
            resolve({ status: "fail", message: `${hostname}: no certificate returned` });
            return;
          }

          const expiry = new Date(cert.valid_to);
          const daysRemaining = Math.floor(
            (expiry.getTime() - Date.now()) / (1000 * 60 * 60 * 24),
          );

          if (daysRemaining < 0) {
            resolve({
              status: "fail",
              message: `${hostname}: certificate expired ${Math.abs(daysRemaining)} day(s) ago`,
              hint: `Renew the SSL certificate for ${hostname}`,
            });
          } else if (daysRemaining < minDaysRemaining) {
            resolve({
              status: "warn",
              message: `${hostname}: certificate expires in ${daysRemaining} day(s)`,
              hint: `Renew the SSL certificate for ${hostname} soon`,
            });
          } else {
            resolve({
              status: "ok",
              message: `${hostname}: certificate valid, expires in ${daysRemaining} day(s)`,
            });
          }
        },
      );

      socket.on("timeout", () => {
        socket.destroy();
        resolve({
          status: "fail",
          message: `${hostname}:${port} TLS connection timed out`,
          hint: `Check that ${hostname}:${port} is accessible`,
        });
      });

      socket.on("error", (err) => {
        resolve({
          status: "fail",
          message: `${hostname}: TLS error - ${err.message}`,
          hint: `Check that ${hostname}:${port} is accessible and has a valid certificate`,
        });
      });
    });
}
