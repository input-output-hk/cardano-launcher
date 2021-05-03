// Copyright © 2020 IOHK
// License: Apache-2.0

/**
 * Module for starting and managing a Cardano node and wallet backend.
 *
 * The main class is [[Launcher]].
 *
 * @packageDocumentation
 */

import mkdirp from 'mkdirp';
import process from 'process';
import net from 'net';

import _ from 'lodash';
import { EventEmitter } from 'tsee';

import { Logger, prependName } from './logging';
import {
  Service,
  ServiceExitStatus,
  ServiceStatus,
  setupService,
  serviceExitStatusMessage,
} from './service';
import {
  DirPath,
  passthroughErrorLogger,
  ignorePromiseRejection,
} from './common';
import {
  LaunchConfig,
  cardanoWalletStartService,
  WalletStartService,
  WalletServiceInfo,
} from './cardanoWallet';
import { Api } from './walletApi';

import * as cardanoNode from './cardanoNode';
import { NodeServiceInfo, NodeStartService } from './cardanoNode';
import Signals = NodeJS.Signals;

export {
  ServiceStatus,
  ServiceExitStatus,
  serviceExitStatusMessage,
  Service,
} from './service';
export { LaunchConfig, WalletStartService } from './cardanoWallet';
export { NodeStartService } from './cardanoNode';
export { Api } from './walletApi';

/*******************************************************************************
 * Exit status types
 ******************************************************************************/

/**
 * The result after the launched wallet backend has finished.
 */
export interface ExitStatus {
  wallet: ServiceExitStatus;
  node: ServiceExitStatus;
}

/**
 * Format an [[ExitStatus]] as a multiline human-readable string.
 */
export function exitStatusMessage(status: ExitStatus): string {
  return _.map(status, serviceExitStatusMessage).join('\n');
}

/**
 * This instance of [[Error]] will be returned when the
 * `Launcher.start()` promise is rejected.
 */
export class BackendExitedError extends Error {
  status: ExitStatus;
  constructor(status: ExitStatus) {
    super(exitStatusMessage(status));
    Object.setPrototypeOf(this, new.target.prototype);
    this.status = status;
  }
}

function noop(): void {
  /* empty */
}

/*******************************************************************************
 * Launching
 ******************************************************************************/

/**
 * This is the main object which controls the launched wallet backend
 * and its node.
 *
 * Example:
 *
 * ```javascript
 * var launcher = new cardanoLauncher.Launcher({
 *   networkName: "mainnet",
 *   stateDir: "/tmp/state-launcher",
 *   nodeConfig: {
 *     kind: "shelley",
 *     configurationDir: "/home/user/cardano-node/configuration/defaults/mainnet",
 *     network: {
 *       configFile: "configuration.yaml",
 *       topologyFile: "topology.json"
 *     }
 *   }
 *   childProcessLogWriteStream: fs.createWriteStream('./logs')
 * });
 * ```
 *
 * Initially, the backend is not started. Use [[Launcher.start]] for that.
 */
export class Launcher {
  /**
   * Use this attribute to monitor and control the `cardano-wallet` process.
   */
  readonly walletService: Service<WalletServiceInfo>;

  /**
   * Use this to access the `cardano-wallet` API server.
   */
  readonly walletBackend: WalletBackend;

  /**
   * Use this to monitor the `cardano-node` process.
   */
  readonly nodeService: Service<NodeServiceInfo>;

  /** Logging adapter */
  protected logger: Logger;

  /** Wallet API server port - set once it's known. */
  private apiPort = 0;

  /** A state flag for whether the backend services have exited yet. */
  private exited = false;

  /** Removes process signal handlers, if they were installed. */
  private cleanupSignalHandlers: () => void = noop;

  /**
   * Sets up a Launcher which can start and control the wallet backend.
   *
   * @param config - controls how the wallet and node are started
   * @param logger - logging backend that launcher will use
   */
  constructor(config: LaunchConfig, logger: Logger = console) {
    logger.debug('Launcher init');
    const {
      childProcessLogWriteStreams,
      installSignalHandlers = true,
    } = config;
    this.logger = logger;

    const start = Launcher.makeServiceCommands(config, logger);
    this.walletService = setupService(
      start.wallet,
      prependName(logger, 'wallet'),
      childProcessLogWriteStreams?.wallet
    );
    this.nodeService = setupService(
      start.node,
      prependName(logger, 'node'),
      childProcessLogWriteStreams?.node
    );

    this.walletBackend = {
      getApi: () => this.walletService?.getConfig()?.status?.info?.api as Api,
      events: new EventEmitter<{
        ready: (api: Api) => void;
        exit: (status: ExitStatus) => void;
      }>(),
    };

    start.wallet
      .then((startService: WalletStartService) => {
        this.apiPort = startService.status.info.port;
      })
      .catch(passthroughErrorLogger);

    this.walletService.events.on('statusChanged', status => {
      if (status === ServiceStatus.Stopped) {
        this.logger.debug('wallet exited');
        this.stop().catch(passthroughErrorLogger);
      }
    });

    this.nodeService.events.on('statusChanged', status => {
      if (status === ServiceStatus.Stopped) {
        this.logger.debug('node exited');
        this.stop().catch(passthroughErrorLogger);
      }
    });

    if (installSignalHandlers) this.installSignalHandlers();
  }

  /**
   * Starts the wallet and node.
   *
   * Example:
   *
   * ```javascript
   * launcher.start().then(function(api) {
   *   console.log("*** cardano-wallet backend is ready, base URL is " + api.baseUrl);
   * });
   * ```
   *
   * @return a promise that will be fulfilled when the wallet API
   * server is ready to accept requests.
   */
  start(): Promise<Api> {
    const stopWaiting = (): boolean =>
      this.nodeService.getStatus() > ServiceStatus.Started ||
      this.walletService.getStatus() > ServiceStatus.Started;

    return new Promise((resolve, reject) => {
      this.nodeService.start().catch(ignorePromiseRejection);
      this.walletService.start().catch(ignorePromiseRejection);

      this.waitForApi(stopWaiting, () => {
        this.walletBackend.events.emit('ready', this.walletBackend.getApi());
      });

      this.walletBackend.events.on('ready', resolve);
      this.walletBackend.events.on('exit', st =>
        reject(new BackendExitedError(st))
      );
    });
  }

  /**
   * Poll TCP port of wallet API server until it accepts connections.
   *
   * @param stop - a callback, which will terminate the polling loop
   *   if it returns a truey value.
   *
   * @param ready - a callback which is called once the wallet API
   *   server accepts connections.
   */
  private waitForApi(stop: () => boolean, ready: () => void): void {
    this.logger.debug('waitForApi');

    let addr: net.SocketConnectOpts;
    let client: net.Socket;
    const timer = setInterval(() => {
      if (stop()) {
        clearInterval(timer);
      } else if (this.apiPort) {
        if (!addr) {
          addr = { port: this.apiPort, host: '127.0.0.1' };
          this.logger.info(
            `Waiting for tcp port ${addr.host}:${addr.port} to accept connections...`
          );
        }

        if (client) {
          client.destroy();
        }
        client = new net.Socket();
        client.connect(addr, () => {
          this.logger.info(`... port is ready.`);
          clearInterval(timer);
          ready();
        });
        client.on('error', err => {
          this.logger.debug(`waitForApi: not ready yet: ${err}`);
        });
      }
    }, 250);
  }

  /**
   * Stops the wallet backend. Attempts to cleanly shut down the
   * processes. However, if they have not exited before the timeout,
   * they will be killed.
   *
   * @param timeoutSeconds - how long to wait before killing the processes.
   * @return a [[Promise]] that is fulfilled at the timeout, or before.
   *
   * @event exit - `walletBackend.events` will emit this when the
   *   wallet and node have both exited.
   */
  stop(
    timeoutSeconds = 60
  ): Promise<{ wallet: ServiceExitStatus; node: ServiceExitStatus }> {
    this.logger.debug(`Launcher.stop: stopping wallet and node`);
    return Promise.all([
      this.walletService.stop(timeoutSeconds),
      this.nodeService.stop(timeoutSeconds),
    ]).then(([wallet, node]) => {
      const status = { wallet, node };
      this.logger.debug(`Launcher.stop: both services are stopped.`, status);
      if (!this.exited) {
        this.walletBackend.events.emit('exit', status);
        this.exited = true;
      }
      this.cleanupSignalHandlers();
      return status;
    });
  }

  /**
   * Stop services when this process gets killed.
   */
  private installSignalHandlers(): void {
    const signals: Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'];
    const handler = (signal: Signals): void => {
      this.logger.info(`Received ${signal} - stopping services...`);
      this.walletService.stop(0).catch(passthroughErrorLogger);
      this.nodeService.stop(0).catch(passthroughErrorLogger);
    };
    signals.forEach(signal => process.on(signal, handler));
    this.cleanupSignalHandlers = (): void => {
      signals.forEach(signal => process.off(signal, handler));
      this.cleanupSignalHandlers = noop;
    };
  }

  private static makeServiceCommands(
    config: LaunchConfig,
    logger: Logger
  ): { wallet: Promise<WalletStartService>; node: Promise<NodeStartService> } {
    logger.info(
      `Creating state directory ${config.stateDir} (if it doesn't already exist)`
    );
    const node = mkdirp(config.stateDir).then(() =>
      Launcher.nodeExe(config.stateDir, config)
    );
    const wallet = node.then(() => Launcher.walletExe(config.stateDir, config));
    return { wallet, node };
  }

  private static async walletExe(
    baseDir: DirPath,
    config: LaunchConfig
  ): Promise<WalletStartService> {
    return cardanoWalletStartService(baseDir, config);
  }

  private static nodeExe(
    baseDir: DirPath,
    config: LaunchConfig
  ): Promise<NodeStartService> {
    switch (config.nodeConfig.kind) {
      case 'shelley':
        return cardanoNode.startCardanoNode(
          baseDir,
          config.nodeConfig,
          config.networkName
        );
    }
  }
}

/**
 * Represents the API service of `cardano-wallet`.
 */
export interface WalletBackend {
  /**
   * @return HTTP connection parameters for the `cardano-wallet` API server.
   */
  getApi(): Api;

  /**
   * An [[EventEmitter]] that can be used to register handlers when
   * the process changes status.
   *
   * ```typescript
   * launcher.walletBackend.events.on('ready', api => { ... });
   * ```
   */
  events: WalletBackendEvents;
}

/**
 * The type of events for [[WalletBackend]].
 */
type WalletBackendEvents = EventEmitter<{
  /**
   * [[Launcher.walletBackend.events]] will emit this when the API
   *  server is ready to accept requests.
   * @event
   */
  ready: (api: Api) => void;
  /** [[Launcher.walletBackend.events]] will emit this when the
   *  wallet and node have both exited.
   * @event
   */
  exit: (status: ExitStatus) => void;
}>;
