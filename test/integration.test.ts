// Copyright © 2020 IOHK
// License: Apache-2.0

import {
  Launcher,
  LaunchConfig,
  ServiceStatus,
  Api,
  WalletStartService,
  NodeStartService,
} from '../src';

import * as http from 'http';
import * as https from 'https';
import * as tmp from 'tmp-promise';
import * as path from 'path';
import * as fs from 'fs';
import { stat } from 'fs-extra';

import * as cardanoNode from '../src/cardanoNode';
import { ExitStatus } from '../src/cardanoLauncher';
import { passthroughErrorLogger } from '../src/common';
import {
  makeRequest,
  setupExecPath,
  withMainnetConfigDir,
  getShelleyConfigDir,
  listExternalAddresses,
  testPort,
} from './utils';

// increase time available for tests to run
const longTestTimeoutMs = 15000;
const tlsDir = path.resolve(__dirname, 'data', 'tls');

// Increase time available for tests to run to work around bug
// https://github.com/input-output-hk/cardano-node/issues/1086
const veryLongTestTimeoutMs = 70000;
const defaultStopTimeout = 10;

setupExecPath();

describe('Starting cardano-wallet (and its node)', () => {
  beforeEach(setupCleanupHandlers);
  afterEach(runCleanupHandlers);

  // eslint-disable-next-line jest/expect-expect
  it(
    'cardano-wallet responds to requests',
    () =>
      launcherTest(stateDir => {
        return {
          stateDir,
          networkName: 'testnet',
          nodeConfig: {
            kind: 'shelley',
            configurationDir: getShelleyConfigDir('testnet'),
            network: cardanoNode.networks.testnet,
          },
        };
      }),
    longTestTimeoutMs
  );

  it(
    'emits one and only one exit event',
    async () => {
      const launcher = await setupTestLauncher(stateDir => {
        return {
          stateDir,
          networkName: 'testnet',
          nodeConfig: {
            kind: 'shelley',
            configurationDir: getShelleyConfigDir('testnet'),
            network: cardanoNode.networks.testnet,
          },
        };
      });

      const events: ExitStatus[] = [];
      launcher.walletBackend.events.on('exit', st => events.push(st));

      await launcher.start();
      await Promise.all([
        launcher.stop(defaultStopTimeout),
        launcher.stop(defaultStopTimeout),
        launcher.stop(defaultStopTimeout),
      ]);
      await launcher.stop(defaultStopTimeout);

      expect(events).toHaveLength(1);
    },
    veryLongTestTimeoutMs
  );

  it(
    'accepts WriteStreams to pipe each child process stdout and stderr streams',
    () =>
      withMainnetConfigDir(async configurationDir => {
        const walletLogFile = await tmp.file();
        const nodeLogFile = await tmp.file();
        const launcher = new Launcher({
          stateDir: (
            await tmp.dir({
              unsafeCleanup: true,
              prefix: 'launcher-integration-test-',
            })
          ).path,
          networkName: 'testnet',
          nodeConfig: {
            kind: 'shelley',
            configurationDir,
            network: cardanoNode.networks.testnet,
          },
          childProcessLogWriteStreams: {
            node: fs.createWriteStream(nodeLogFile.path, {
              fd: nodeLogFile.fd,
            }),
            wallet: fs.createWriteStream(walletLogFile.path, {
              fd: walletLogFile.fd,
            }),
          },
        });
        await launcher.start();
        await launcher.stop(defaultStopTimeout);
        const nodeLogFileStats = await stat(nodeLogFile.path);
        const walletLogFileStats = await stat(walletLogFile.path);
        expect(nodeLogFileStats.size).toBeGreaterThan(0);
        expect(walletLogFileStats.size).toBeGreaterThan(0);
      }),
    veryLongTestTimeoutMs
  );

  it(
    'accepts the same WriteStream for both the wallet and node to produce a combined stream',
    async () =>
      await withMainnetConfigDir(async configurationDir => {
        const logFile = await tmp.file();
        const writeStream = fs.createWriteStream(logFile.path, {
          fd: logFile.fd,
        });
        const launcher = new Launcher({
          stateDir: (
            await tmp.dir({
              unsafeCleanup: true,
              prefix: 'launcher-integration-test-',
            })
          ).path,
          networkName: 'mainnet',
          nodeConfig: {
            kind: 'shelley',
            configurationDir,
            network: cardanoNode.networks.testnet,
          },
          childProcessLogWriteStreams: {
            node: writeStream,
            wallet: writeStream,
          },
        });
        await launcher.start();
        const logFileStats = await stat(writeStream.path);
        expect(logFileStats.size).toBeGreaterThan(0);
        await launcher.stop(defaultStopTimeout);
      }),
    veryLongTestTimeoutMs
  );

  // eslint-disable-next-line jest/expect-expect
  it(
    'can configure the cardano-wallet to serve the API with TLS',
    async () =>
      launcherTest(stateDir => {
        return {
          stateDir,
          networkName: 'testnet',
          nodeConfig: {
            kind: 'shelley',
            configurationDir: getShelleyConfigDir('testnet'),
            network: cardanoNode.networks.testnet,
          },
          tlsConfiguration: {
            caCert: path.join(tlsDir, 'ca.crt'),
            svCert: path.join(tlsDir, 'server', 'server.crt'),
            svKey: path.join(tlsDir, 'server', 'server.key'),
          },
        };
      }, true),
    veryLongTestTimeoutMs
  );

  it(
    'handles case where cardano-node fails during initialisation',
    async () => {
      expect.assertions(4);
      await withMainnetConfigDir(async configurationDir => {
        const launcher = await setupTestLauncher(stateDir => {
          // cardano-node will expect this to be a directory, and exit with an error
          fs.writeFileSync(path.join(stateDir, 'chain'), 'bomb');

          return {
            stateDir,
            networkName: 'testnet',
            nodeConfig: {
              kind: 'shelley',
              configurationDir,
              network: cardanoNode.networks.testnet,
            },
          };
        });

        await launcher.start().catch(passthroughErrorLogger);

        const expectations = new Promise((done, fail) =>
          launcher.walletBackend.events.on('exit', (status: ExitStatus) => {
            try {
              expect(status.wallet.code).toBe(0);
              expect(status.node.code).not.toBe(0);
              // TODO: cardano-node 1.26.2 is not exiting properly on windows
              if (process.platform !== 'win32') {
                expect(status.node.signal).toBeNull();
              } else {
                // keep the same number of assertions
                expect(status.node).not.toBeNull();
              }
            } catch (e) {
              fail(e);
            }
            done();
          })
        );

        await launcher.stop(defaultStopTimeout);

        await expectations;
      });
    },
    veryLongTestTimeoutMs
  );

  it(
    'services listen only on a private address',
    async () => {
      const launcher = await setupTestLauncher(stateDir => {
        return {
          stateDir,
          networkName: 'testnet',
          nodeConfig: {
            kind: 'shelley',
            configurationDir: getShelleyConfigDir('testnet'),
            network: cardanoNode.networks.testnet,
          },
        };
      });

      await launcher.start();
      const walletInfo = (launcher.walletService.getConfig() as WalletStartService)
        .status?.info;
      const nodeInfo = (launcher.nodeService.getConfig() as NodeStartService)
        .status.info;

      for (const host of listExternalAddresses()) {
        console.log(`Testing ${host}`);
        expect(await testPort(host, walletInfo['port'], console)).toBe(false);
        expect(await testPort(host, nodeInfo['listenPort'], console)).toBe(
          false
        );
      }

      await launcher.stop(defaultStopTimeout);
    },
    veryLongTestTimeoutMs
  );
});

async function setupTestLauncher(
  config: (stateDir: string) => LaunchConfig
): Promise<Launcher> {
  const stateDir = await tmp.dir({
    unsafeCleanup: true,
    prefix: 'launcher-integration-test-',
  });

  if (!process.env.NO_CLEANUP) {
    cleanups.push(() => stateDir.cleanup());
  }

  const launcher = new Launcher(config(stateDir.path));

  launcher.walletService.events.on('statusChanged', (status: ServiceStatus) => {
    console.log('wallet service status changed ' + ServiceStatus[status]);
  });

  launcher.nodeService.events.on('statusChanged', (status: ServiceStatus) => {
    console.log('node service status changed ' + ServiceStatus[status]);
  });

  launcher.walletBackend.events.on('ready', (api: Api) => {
    console.log('ready event ', api);
  });

  cleanups.push(async () => {
    console.debug('Test has finished; stopping launcher.');
    await launcher.stop(2);
    console.debug('Stopped. Removing event listeners.');
    launcher.walletBackend.events.removeAllListeners();
    launcher.walletService.events.removeAllListeners();
    launcher.nodeService.events.removeAllListeners();
  });

  return launcher;
}

async function launcherTest(
  config: (stateDir: string) => LaunchConfig,
  tls = false
): Promise<void> {
  const launcher = await setupTestLauncher(config);
  const api = await launcher.start();
  const walletProc = launcher.walletService.getProcess();
  const nodeProc = launcher.nodeService.getProcess();

  expect(walletProc).toHaveProperty('pid');
  expect(nodeProc).toHaveProperty('pid');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const info: any = await new Promise((resolve, reject) => {
    console.log('running req');
    const networkModule = tls ? https : http;
    const req = networkModule.request(
      makeRequest(
        api,
        'network/information',
        tls
          ? {
              ca: fs.readFileSync(path.join(tlsDir, 'ca.crt')),
              cert: fs.readFileSync(path.join(tlsDir, 'client', 'client.crt')),
              key: fs.readFileSync(path.join(tlsDir, 'client', 'client.key')),
            }
          : {}
      ),
      res => {
        res.setEncoding('utf8');
        res.on('data', d => resolve(JSON.parse(d)));
      }
    );
    req.on('error', (e: Error) => {
      console.error(`problem with request: ${e.message}`);
      reject(e);
    });
    req.end();
  });

  console.log('info is ', info);

  expect(info.node_tip).toBeTruthy();

  await launcher.stop(defaultStopTimeout);
  console.log('stopped');
}

type CleanupFunc = () => Promise<void>;

const cleanups: CleanupFunc[] = [];

function setupCleanupHandlers() {
  console.info('Starting test');
  expect(cleanups).toHaveLength(0);
}

async function runCleanupHandlers() {
  console.info('Cleaning up after test');
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop() as CleanupFunc;
    await cleanup();
  }
}
