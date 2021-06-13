// Copyright © 2020 IOHK
// License: Apache-2.0

import { withDir, DirectoryResult } from 'tmp-promise';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';
import _ from 'lodash';

import { Service, ServiceStatus, Api } from '../src';
import { StartService, ShutdownMethod } from '../src/service';
import { Logger, LogFunc } from '../src/logging';
import { ServerOptions } from 'http';
import { ServerOptions as HttpsServerOptions, RequestOptions } from 'https';

/*******************************************************************************
 * Utils
 ******************************************************************************/

/** Construct a promise to a service command. */
export function testService(
  command: string,
  args: string[],
  shutdownMethod = ShutdownMethod.CloseStdin
): Promise<StartService<unknown>> {
  return new Promise(resolve =>
    resolve({ command, args, shutdownMethod, status: { info: {} } })
  );
}

/**
 * Expect the given process ID to not exist.
 */
export const expectProcessToBeGone = (pid: number, signal = 0): void => {
  expect(() => process.kill(pid, signal)).toThrow();
};

/**
 * @return mutable array which will contain events as they occur.
 */
export const collectEvents = (service: Service<unknown>): ServiceStatus[] => {
  const events: ServiceStatus[] = [];
  service.events.on('statusChanged', status => events.push(status));
  return events;
};

export interface MockLog {
  severity: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  param: unknown;
}

export interface MockLogger extends Logger {
  getLogs(): MockLog[];
}

export function mockLogger(echo = false): MockLogger {
  const logs: MockLog[] = [];

  const mockLog = (severity: 'debug' | 'info' | 'warn' | 'error'): LogFunc => {
    return (msg: string, param?: unknown): void => {
      if (echo) {
        if (param) {
          console[severity](msg, param);
        } else {
          console[severity](msg);
        }
      }
      logs.push({ severity, msg, param: param || undefined });
    };
  };

  return {
    debug: mockLog('debug'),
    info: mockLog('info'),
    warn: mockLog('warn'),
    error: mockLog('error'),
    getLogs: (): MockLog[] => logs,
  };
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Sets up the parameters for `http.request` for this Api.
 *
 * @param path - the api route (without leading slash)
 * @param options - extra options to be added to the request.
 * @return an options object suitable for `http.request`
 */
export function makeRequest(
  api: Api,
  path: string,
  options?: ServerOptions | HttpsServerOptions
): RequestOptions {
  return Object.assign(
    {},
    api.requestParams,
    {
      path: api.requestParams.path + path,
    },
    options
  );
}

/**
 * Adds the current working directory to the PATH, only when running
 * under Windows.
 *
 * This means that the wallet and node executables can be "installed"
 * in the source directory.
 *
 * If the node backend is run in a different working directory,
 * Windows will still be able to find the executables
 */
export function setupExecPath(): void {
  if (process.platform === 'win32') {
    const cwd = process.cwd();
    const paths = (process.env.PATH || '')
      .split(path.delimiter)
      .filter(p => p !== cwd);
    paths.unshift(cwd);
    process.env.PATH = paths.join(path.delimiter);
    console.info('PATH=' + process.env.PATH);
  }
}

export function getShelleyConfigDir(networkName: string): string {
  const base = process.env.CARDANO_NODE_CONFIGS;
  if (!base) {
    const msg =
      'CARDANO_NODE_CONFIGS environment variable is not set. The tests will not work.';
    console.error(msg);
    throw new Error(msg);
  }

  return path.resolve(base, networkName);
}

/**
 * Set up a temporary directory containing configuration files for
 * Shelley mainnet.
 *
 * This is needed because files in the cardano-node configuration file
 * are resolved relative to the current working directory, rather than
 * relative to the path of the config file.
 *
 * The temporary directory is deleted after the callback completes,
 * unless the environment variable `NO_CLEANUP` is set.
 */
export async function withMainnetConfigDir<T>(
  cb: (configDir: string) => Promise<T>
): Promise<T> {
  const mainnet = getShelleyConfigDir('mainnet');

  return await withDir(
    async (o: DirectoryResult) => {
      const configs = _.mapValues(
        {
          configuration: 'configuration.json',
          genesisByron: 'genesis-byron.json',
          genesisShelley: 'genesis-shelley.json',
          topology: 'topology.json',
        },
        (f: string) => {
          return {
            src: path.join(mainnet, f),
            dst: path.join(o.path, f),
          };
        }
      );

      await fs.promises.copyFile(
        configs.genesisByron.src,
        configs.genesisByron.dst
      );
      await fs.promises.copyFile(
        configs.genesisShelley.src,
        configs.genesisShelley.dst
      );
      await fs.promises.copyFile(configs.topology.src, configs.topology.dst);

      const config = await fs.promises.readFile(
        configs.configuration.src,
        'utf-8'
      );
      const configFixed = config.replace(/^.*SocketPath.*$/gm, '');
      await fs.promises.writeFile(configs.configuration.dst, configFixed);

      return await cb(o.path);
    },
    {
      unsafeCleanup: true,
      keep: !!process.env.NO_CLEANUP,
      prefix: 'launcher-test-config-',
    }
  );
}

/** @returns a list of addresses for all non-internal network interfaces **/
export function listExternalAddresses(family?: string): string[] {
  const isExternal = (iface: os.NetworkInterfaceInfo): boolean =>
    (!family || iface.family === family) &&
    !iface.internal &&
    iface.address != '0';

  const externalAddrs = (iface: os.NetworkInterfaceInfo) =>
    isExternal(iface) ? [iface.address] : [];
  const ifaceAddrs = (ifaces: os.NetworkInterfaceInfo[] | undefined) =>
    ifaces ? _.map(ifaces, externalAddrs) : [];

  return _.flattenDeep(_.map(os.networkInterfaces(), ifaceAddrs));
}

/** Try to make a connection to a port and return whether this succeeded. */
export function testPort(
  host: string,
  port: number,
  logger: Logger
): Promise<boolean> {
  const addr = { host, port };
  console.log(`Testing TCP port ${addr.host}:${addr.port}...`);

  return new Promise(resolve => {
    const client = new net.Socket();
    client.connect(addr, () => {
      logger.info(`... port accepted a connection`);
      resolve(true);
    });
    client.on('error', err => {
      logger.info(`... port refused a connection: ${err}`);
      resolve(false);
    });
  });
}
