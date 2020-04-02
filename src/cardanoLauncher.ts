// Copyright © 2020 IOHK
// License: Apache-2.0

/**
 * Module for starting and managing a Cardano node and wallet backend.
 *
 * The main class is [[Launcher]].
 *
 * @packageDocumentation
 */

import path from 'path'
import mkdirp from 'mkdirp'
import process from 'process'
import net from 'net'

import _ from 'lodash'
import { EventEmitter } from 'tsee'
import getPort from 'get-port'

import { Logger, prependName } from './logging'
import {
  Service,
  ServiceExitStatus,
  ServiceStatus,
  StartService,
  setupService,
  serviceExitStatusMessage
} from './service'
import { DirPath } from './common'

import * as byron from './byron'
import * as shelley from './shelley'
import * as jormungandr from './jormungandr'
import { WriteStream } from 'fs'

export {
  ServiceStatus,
  ServiceExitStatus,
  serviceExitStatusMessage,
  Service
} from './service'

/**
 * Configuration parameters for starting the wallet backend and node.
 */
export interface LaunchConfig {
  /**
   * Directory to store wallet databases, the blockchain, socket
   * files, etc.
   */
  stateDir: string

  /**
   * Label for the network that will connected. This is used in the
   * state directory path name.
   */
  networkName: string

  /**
   * TCP port to use for the `cardano-wallet` API server.
   * The default is to select any free port.
   */
  apiPort?: number

  /**
   * IP address or hostname to bind the `cardano-wallet` API server
   * to. Can be an IPv[46] address, hostname, or `'*'`. Defaults to
   * 127.0.0.1.
   */
  listenAddress?: string

  /**
   * Overrides the URL to the zip file containing stake pool metadata
   * which is downloaded by cardano-wallet.
   *
   * This is only useful in testing scenarios, or when running a local
   * development testnet.
   *
   * For Jörmungandr ITN, the default is
   * https://github.com/cardano-foundation/incentivized-testnet-stakepool-registry/archive/master.zip.
   */
  stakePoolRegistryUrl?: string

  /**
   * Maximum time difference (in seconds) between the tip slot and the
   * latest applied block within which we consider a wallet being
   * synced with the network. Defaults to 300 seconds.
   */
  syncToleranceSeconds?: number

  /**
   * Configuration for starting `cardano-node`. The `kind` property will be one of
   *  * `"byron"` - [[ByronNodeConfig]]
   *  * `"shelley"` - [[ShelleyNodeConfig]]
   *  * `"jormungandr"` - [[JormungandrConfig]]
   */
  nodeConfig:
  | byron.ByronNodeConfig
  | shelley.ShelleyNodeConfig
  | jormungandr.JormungandrConfig

  /**
   *  WriteStream for writing the child process data events from stdout and stderr
   */
  childProcessLogWriteStream?: WriteStream

  /**
   *  Control the termination signal handling. Set this to false if the default
   *  behaviour interferes with your application shutdown behaviour.
   *  If setting this to false, ensure stop(0) is called as part of the shutdown.
   */
  installSignalHandlers?: Boolean
}

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
 *     kind: "byron",
 *     configurationDir: "/home/user/cardano-node/configuration",
 *     network: {
 *       configFile: "configuration-mainnet.yaml",
 *       topologyFile: "mainnet-topology.json"
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
  readonly walletService: Service;

  /**
   * Use this to access the `cardano-wallet` API server.
   */
  readonly walletBackend: WalletBackend;

  /**
   * Use this to monitor the `cardano-node` process.
   */
  readonly nodeService: Service;

  /** Logging adapter */
  protected logger: Logger;

  /** Wallet API server port - set once it's known. */
  private apiPort = 0;

  /** A state flag for whether the backend services have exited yet. */
  private exited = false;

  /**
   * Sets up a Launcher which can start and control the wallet backend.
   *
   * @param config - controls how the wallet and node are started
   * @param logger - logging backend that launcher will use
   */
  constructor (config: LaunchConfig, logger: Logger = console) {
    logger.debug('Launcher init')
    const { childProcessLogWriteStream, installSignalHandlers = true } = config
    this.logger = logger

    const start = makeServiceCommands(config, logger)
    this.walletService = setupService(
      start.wallet,
      prependName(logger, 'wallet'),
      childProcessLogWriteStream
    )
    this.nodeService = setupService(
      start.node,
      prependName(logger, 'node'),
      childProcessLogWriteStream
    )

    this.walletBackend = {
      getApi: () => new V2Api(this.apiPort),
      events: new EventEmitter<{
        ready: (api: Api) => void
        exit: (status: ExitStatus) => void
      }>()
    }

    start.wallet.then((startService: WalletStartService) => {
      this.apiPort = startService.apiPort
    }).catch(error => console.error((error.message)))

    this.walletService.events.on('statusChanged', status => {
      if (status === ServiceStatus.Stopped) {
        this.logger.debug('wallet exited')
        this.stop().catch(error => console.error((error.message)))
      }
    })

    this.nodeService.events.on('statusChanged', status => {
      if (status === ServiceStatus.Stopped) {
        this.logger.debug('node exited')
        this.stop().catch(error => console.error((error.message)))
      }
    })

    if (installSignalHandlers === true) this.installSignalHandlers()
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
  async start (): Promise<Api> {
    await this.nodeService.start()
    await this.walletService.start()

    const stopWaiting = (): boolean =>
      this.nodeService.getStatus() > ServiceStatus.Started ||
      this.walletService.getStatus() > ServiceStatus.Started

    this.waitForApi(stopWaiting)
      .then(() => {
        this.walletBackend.events.emit('ready', this.walletBackend.getApi())
      })
      .catch(error => console.error((error.message)))

    return await new Promise((resolve, reject) => {
      this.walletBackend.events.on('ready', resolve)
      this.walletBackend.events.on('exit', st =>
        reject(new BackendExitedError(st))
      )
    })
  }

  /**
   * Poll TCP port of wallet API server until it accepts connections.
   * @param stop - a callback, which will terminate the polling loop if it returns a truey value.
   * @return a promise that is completed once the wallet API server accepts connections.
   */
  private async waitForApi (stop: () => boolean): Promise<void> {
    this.logger.debug('waitForApi')
    return await new Promise((resolve, reject) => {
      // let client: net.Socket
      const poll = (): void => {
        if (stop()) {
          clearInterval(timer)
          reject(new Error('Polling stopped'))
        } else if (this.apiPort !== 0) {
          const addr: net.SocketConnectOpts = { port: this.apiPort, host: '127.0.0.1' }
          this.logger.info(
            `Waiting for tcp port ${addr.host as string}:${addr.port} to accept connections...`
          )
          // if (client !== undefined) {
          //   client.destroy()
          // }
          const client = new net.Socket()
          client.connect(addr, () => {
            this.logger.info('... port is ready.')
            clearInterval(timer)
            resolve()
          })
          client.on('error', err => {
            this.logger.debug(`waitForApi: not ready yet: ${err.message}`)
          })
        }
      }
      const timer = setInterval(poll, 250)
    })
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
  async stop (
    timeoutSeconds = 60
  ): Promise<{ wallet: ServiceExitStatus, node: ServiceExitStatus }> {
    this.logger.debug('Launcher.stop: stopping wallet and node')
    return await Promise.all([
      this.walletService.stop(timeoutSeconds),
      this.nodeService.stop(timeoutSeconds)
    ]).then(([wallet, node]) => {
      const status = { wallet, node }
      this.logger.debug('Launcher.stop: both services are stopped.', status)
      if (!this.exited) {
        this.walletBackend.events.emit('exit', status)
        this.exited = true
      }
      return status
    })
  }

  /**
   * Stop services when this process gets killed.
   */
  private installSignalHandlers (): void {
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']
    signals.forEach((signal: NodeJS.Signals) =>
      process.on(signal, () => {
        this.logger.info(`Received ${signal} - stopping services...`)
        this.walletService.stop(0).catch(error => console.error((error.message)))
        this.nodeService.stop(0).catch(error => console.error((error.message)))
      })
    )
  }
}

interface RequestParams {
  port: number
  path: string
  hostname: string
}

/**
 * Connection parameters for the `cardano-wallet` API.
 * These should be used to build the HTTP requests.
 */
export interface Api {
  /**
   * API base URL, including trailling slash.
   */
  baseUrl: string

  /**
   * URL components which can be used with the HTTP client library of
   * your choice.
   */
  requestParams: RequestParams
}

class V2Api implements Api {
  /** URL of the API, including a trailling slash. */
  readonly baseUrl: string;
  /** URL components which can be used with the HTTP client library of
   * your choice. */
  readonly requestParams: RequestParams;

  constructor (port: number) {
    const hostname = '127.0.0.1'
    const path = '/v2/'
    this.baseUrl = `http://${hostname}:${port}${path}`
    this.requestParams = { port, path, hostname }
  }
}

/**
 * The result after the launched wallet backend has finished.
 */
export interface ExitStatus {
  wallet: ServiceExitStatus
  node: ServiceExitStatus
}

/**
 * This instance of [[Error]] will be returned when the
 * `Launcher.start()` promise is rejected.
 */
export class BackendExitedError extends Error {
  status: ExitStatus;
  constructor (status: ExitStatus) {
    super(exitStatusMessage(status))
    Object.setPrototypeOf(this, new.target.prototype)
    this.status = status
  }
}

/**
 * Format an [[ExitStatus]] as a multiline human-readable string.
 */
export function exitStatusMessage (status: ExitStatus): string {
  return _.map(status, serviceExitStatusMessage).join('\n')
}

/**
 * Represents the API service of `cardano-wallet`.
 */
export interface WalletBackend {
  /**
   * @return HTTP connection parameters for the `cardano-wallet` API server.
   */
  getApi(): Api

  /**
   * An [[EventEmitter]] that can be used to register handlers when
   * the process changes status.
   *
   * ```typescript
   * launcher.walletBackend.events.on('ready', api => { ... });
   * ```
   */
  events: WalletBackendEvents
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
  ready: (api: Api) => void
  /** [[Launcher.walletBackend.events]] will emit this when the
   *  wallet and node have both exited.
   * @event
   */
  exit: (status: ExitStatus) => void
}>;

interface WalletStartService extends StartService {
  apiPort: number
}

function makeServiceCommands (
  config: LaunchConfig,
  logger: Logger
): { wallet: Promise<WalletStartService>, node: Promise<StartService> } {
  logger.info(
    `Creating state directory ${config.stateDir} (if it doesn't already exist)`
  )
  const node = mkdirp(config.stateDir).then(async () =>
    await nodeExe(config.stateDir, config)
  )
  const wallet = node.then(async () =>
    await walletExe(config.stateDir, config)
  )
  return { wallet, node }
}

async function walletExe (
  baseDir: DirPath,
  config: LaunchConfig
): Promise<WalletStartService> {
  const apiPort = config.apiPort ?? (await getPort())
  const base: WalletStartService = {
    command: `cardano-wallet-${config.nodeConfig.kind}`,
    args: [
      'serve',
      '--shutdown-handler',
      '--port',
      `${apiPort}`,
      '--database',
      path.join(baseDir, 'wallets')
    ].concat(
      config.listenAddress !== undefined ? ['--listen-address', config.listenAddress] : [],
      config.syncToleranceSeconds !== undefined
        ? ['--sync-tolerance', `${config.syncToleranceSeconds}s`]
        : []
    ),
    extraEnv: config.stakePoolRegistryUrl !== undefined
      ? { CARDANO_WALLET_STAKE_POOL_REGISTRY_URL: config.stakePoolRegistryUrl }
      : undefined,
    supportsCleanShutdown: true,
    apiPort
  }
  const addArgs = (args: string[]): WalletStartService =>
    _.assign(base, { args: base.args.concat(args) })

  switch (config.nodeConfig.kind) {
    case 'jormungandr':
      return addArgs(
        (config.nodeConfig.restPort !== undefined
          ? ['--node-port', `${config.nodeConfig.restPort}`]
          : []).concat(['--genesis-block-hash', config.nodeConfig.network.genesisBlock.hash])
      )
    case 'byron':
      if (
        config.networkName !== 'mainnet' &&
        config.nodeConfig.network.genesisFile === undefined
      ) {
        throw new Error('ByronNetwork.genesisFile must be configured')
      }

      return addArgs(
        (config.networkName === 'mainnet'
          ? ['--mainnet']
          : ['--testnet', `${config.nodeConfig.network.genesisFile as string}`]).concat(
          config.nodeConfig.socketFile !== undefined
            ? ['--node-socket', config.nodeConfig.socketFile]
            : []
        )
      )
    case 'shelley':
      return base
  }
}

async function nodeExe (
  baseDir: DirPath,
  config: LaunchConfig
): Promise<StartService> {
  switch (config.nodeConfig.kind) {
    case 'jormungandr':
      return await jormungandr.startJormungandr(baseDir, config.nodeConfig)
    case 'byron':
      return await byron.startByronNode(
        baseDir,
        config.nodeConfig,
        config.networkName
      )
    case 'shelley':
      return await shelley.startShelleyNode(config.nodeConfig)
  }
}
