const colors = require('colors/safe')
import { v4 as uidGen } from 'uuid'

import { KillFn } from './types'
import { makeLogger } from './logger'
import { delay } from './util'
import env from './env'
import * as T from './types'
import {
  CellNick,
  AdminWebsocket,
  AppWebsocket,
  AgentPubKey,
  InstallAppRequest,
  InstallAppBundleRequest,
  ListAppsRequest,
  ListAppsResponse,
  EnableAppResponse,
  RegisterDnaRequest,
  HoloHash,
  DnaProperties,
  AppSignal,
  InstalledAppInfo,
  AppBundleSource
} from '@holochain/conductor-api'
import { Cell } from './cell'
import { Player } from './player'
import { TunneledAdminClient, TunneledAppClient } from './trycp'
import * as fs from 'fs'

// probably unnecessary, but it can't hurt
// TODO: bump this gradually down to 0 until we can maybe remove it altogether
const WS_CLOSE_DELAY_FUDGE = 500

export type CallAdminFunc = (
  method: string,
  params: Record<string, any>
) => Promise<any>

type ConstructorArgs = {
  player: Player
  name: string
  kill: (signal?: string) => Promise<void>
  onSignal: ((signal: AppSignal) => void) | null
  onActivity: () => void
  backend:
    | {
        type: 'local'
        machineHost: string
        adminInterfacePort: number
        appInterfacePort: number
      }
    | {
        type: 'trycp'
        adminInterfaceCall: (req: any) => Promise<any>
        appInterfaceCall: (port: number, message: any) => Promise<any>
        connectAppInterface: (port: number) => Promise<void>
        disconnectAppInterface: (port: number) => Promise<void>
        subscribeAppInterfacePort: (
          port: number,
          onSignal: (signal: AppSignal) => void
        ) => void
        unsubscribeAppInterfacePort: (port: number) => void
        downloadDnaRemote: (url: string) => Promise<string>
        saveDnaRemote: (
          id: string,
          buffer_callback: () => Promise<Buffer>
        ) => Promise<string>
      }
    | { type: 'test' }
}

/**
 * Representation of a running Conductor instance.
 * A [Player] spawns a conductor process locally or remotely and constructs this class accordingly.
 * Though Conductor is spawned externally, this class is responsible for establishing WebSocket
 * connections to the various interfaces to enable zome calls as well as admin and signal handling.
 */
export class Conductor {
  name: string
  logger: any
  kill: KillFn
  adminClient: AdminWebsocket | TunneledAdminClient | null
  appClient: AppWebsocket | TunneledAppClient | null

  _appInterfacePort: number | null = null
  _onSignal: ((signal: AppSignal) => void) | null
  _player: Player
  _isInitialized: boolean
  _onActivity: () => void
  _timeout: number
  _backend:
    | {
        type: 'local'
        adminInterfacePort: number
        appInterfacePort: number
        machineHost: string
      }
    | {
        type: 'trycp'
        appInterfaceCall: (port: number, message: any) => Promise<any>
        connectAppInterface: (port: number) => Promise<void>
        disconnectAppInterface: (port: number) => Promise<void>
        subscribeAppInterfacePort: (
          port: number,
          onSignal: (signal: AppSignal) => void
        ) => void
        unsubscribeAppInterfacePort: (port: number) => void
        downloadDnaRemote: (url: string) => Promise<string>
        saveDnaRemote: (
          id: string,
          buffer_callback: () => Promise<Buffer>
        ) => Promise<string>
      }
    | { type: 'test' }

  constructor ({ player, name, kill, onActivity, backend }: ConstructorArgs) {
    this.name = name
    this.logger = makeLogger(`tryorama conductor ${name}`)
    this.logger.debug('Conductor constructing')

    this.kill = async (signal?): Promise<void> => {
      if (this.appClient !== null) {
        const appClient = this.appClient
        this.appClient = null
        await appClient.client.close()
      }
      if (this.adminClient !== null) {
        const adminClient = this.adminClient
        this.adminClient = null
        await adminClient.client.close()
      }
      this.logger.debug('Killing...')
      await kill(signal)
    }

    switch (backend.type) {
      case 'local':
      case 'test':
        this._backend = backend
        this.adminClient = null
        break
      case 'trycp':
        this._backend = backend
        this.adminClient = new TunneledAdminClient(async message => {
          const res = await backend.adminInterfaceCall(message)
          this._onActivity()
          return res
        })
        break
      default:
        const assertNever: never = backend
    }
    this.appClient = null
    this._player = player
    this._isInitialized = false
    this._onActivity = onActivity
    this._timeout = 30000
  }

  initialize = async () => {
    this._onActivity()
    await this._connectInterfaces()
  }


  listApps = async (status: ListAppsRequest): Promise<ListAppsResponse>  => {
    return await this.adminClient!.listApps(status)
  }

  setSignalHandler = (onSignal: ((signal: AppSignal) => void) | null) => {
    const prevOnSignal = this._onSignal
    if (
      onSignal === null &&
      prevOnSignal !== null &&
      this._appInterfacePort !== null &&
      'unsubscribeAppInterfacePort' in this._backend
    ) {
      this._backend.unsubscribeAppInterfacePort(this._appInterfacePort)
    }
    this._onSignal = onSignal
    if (
      onSignal !== null &&
      prevOnSignal === null &&
      this._appInterfacePort !== null &&
      'subscribeAppInterfacePort' in this._backend
    ) {
      this._backend.subscribeAppInterfacePort(this._appInterfacePort, signal =>
        this._onSignal!(signal)
      )
    }
  }

  // this function registers a DNA from a given source
  registerDna = async (
    source: T.DnaSource,
    uid?,
    properties?
  ): Promise<HoloHash> => {
    if ('path' in source && 'saveDnaRemote' in this._backend) {
      const contents = () =>
        new Promise<Buffer>((resolve, reject) => {
          fs.readFile((source as { path: string }).path, null, (err, data) => {
            if (err) {
              reject(err)
            }
            resolve(data)
          })
        })
      const pathAfterReplacement = source.path.replace(/\//g, '')
      source = { path: await this._backend.saveDnaRemote(pathAfterReplacement, contents) }
    }
    if ('url' in source) {
      if (!('downloadDnaRemote' in this._backend)) {
        throw new Error('encountered URL DNA source on non-remote player')
      }
      source = { path: await this._backend.downloadDnaRemote((source as T.DnaUrl).url)}
    }
    const registerDnaReq: RegisterDnaRequest = { ...source, uid, properties }
    return await this.adminClient!.registerDna(registerDnaReq)
  }

  // this function will install an app bundle as generated by hc app pack
  installBundledHapp = async (
    bundleSource: AppBundleSource,
    agentPubKey?: AgentPubKey,
    installedAppId?: string,
    uid?: string
  ): Promise<T.InstalledHapp> => {
    if (!agentPubKey) {
      agentPubKey = await this.adminClient!.generateAgentPubKey()
    }

    const bundleInstalledAppId = installedAppId || `app-${uidGen()}`
    const installAppBundleReq: InstallAppBundleRequest = {
      ...bundleSource,
      installed_app_id: bundleInstalledAppId,
      agent_key: agentPubKey,
      membrane_proofs: {},
      uid
    }
    return await this._installBundledHapp(installAppBundleReq)
  }

  // install a hApp using the InstallAppBundleRequest struct from conductor-admin-api
  // you must create your own app_id and bundle, this is useful also if you
  // need to pass in uid, properties or membrane-proof
  _installBundledHapp = async (
    installAppBundleReq: InstallAppBundleRequest
  ): Promise<T.InstalledHapp> => {
    const installedAppResponse: InstalledAppInfo = await this.adminClient!.installAppBundle(
      installAppBundleReq
    )
    // must be enabled to be callable
    const enabledAppResponse: EnableAppResponse = await this.adminClient!.enableApp({
      installed_app_id: installedAppResponse.installed_app_id
    })
    if (enabledAppResponse.errors.length > 0) {
      throw new Error(
        `Error - Failed to enable app: ${enabledAppResponse.errors}`
      )
    }
    return this._makeInstalledAgentHapp(enabledAppResponse.app)
  }

  // this function will auto-generate an `installed_app_id` and
  // `dna.nick` for you, to allow simplicity
  installHapp = async (
    agentHapp: T.DnaSrc[],
    agentPubKey?: AgentPubKey
  ): Promise<T.InstalledHapp> => {
    if (!agentPubKey) {
      agentPubKey = await this.adminClient!.generateAgentPubKey()
    }
    const dnaSources = agentHapp
    const installAppReq: InstallAppRequest = {
      installed_app_id: `app-${uidGen()}`,
      agent_key: agentPubKey,
      dnas: await Promise.all(
        dnaSources.map(async (src, index) => {
          let source: T.DnaSource
          if (src instanceof Buffer) {
            source = { hash: src }
          } else if (typeof src === 'string') {
            source = { path: src }
          } else {
            source = { url: src.url }
          }

          let dna = {
            hash: await this.registerDna(source, this._player.scenarioUID),
            nick: `${index}${src}-${uidGen()}`
          }
          return dna
        })
      )
    }
    return await this._installHapp(installAppReq)
  }

  // install a hApp using the InstallAppRequest struct from conductor-admin-api
  // you must create your own app_id and dnas list, this is useful also if you
  // need to pass in properties or membrane-proof
  _installHapp = async (
    installAppReq: InstallAppRequest
  ): Promise<T.InstalledHapp> => {
    await this.adminClient!.installApp(
      installAppReq
    )
    // must be enabled to be callable
    const enabledAppResponse: EnableAppResponse = await this.adminClient!.enableApp({
      installed_app_id: installAppReq.installed_app_id
    })
    if (enabledAppResponse.errors.length > 0) {
      throw new Error(
        `Error - Failed to enable app: ${enabledAppResponse.errors}`
      )
    }
    return this._makeInstalledAgentHapp(enabledAppResponse.app)
  }

  _makeInstalledAgentHapp = (installedAppResponse: InstalledAppInfo): T.InstalledHapp => {
    const agentPubKey = installedAppResponse.cell_data[0].cell_id[1]
    const rawCells = Object.entries(installedAppResponse.cell_data)
    // construct Cell instances which are the most useful class to the client
    const cells = rawCells.map(([_, { cell_id, cell_nick }]) => new Cell({
      cellId: cell_id,
      cellNick: cell_nick,
      player: this._player
    }))

    const installedAgentHapp: T.InstalledHapp = {
      hAppId: installedAppResponse.installed_app_id,
      agent: agentPubKey,
      cells,
    }
    return installedAgentHapp
  }

  _connectInterfaces = async () => {
    if (this._backend.type === 'test') {
      throw new Error(
        'cannot call _connectInterface without a conductor backend'
      )
    }
    this._onActivity()
    // 0 in this case means use any open port
    let appPortNumber = 0
    if (this._backend.type === 'local') {
      const adminWsUrl = `ws://${this._backend.machineHost}:${this._backend.adminInterfacePort}`
      this.adminClient = await AdminWebsocket.connect(adminWsUrl)
      this.logger.debug(
        `connectInterfaces :: connected admin interface at ${adminWsUrl}`
      )
      appPortNumber = this._backend.appInterfacePort
    }
    const {
      port: appInterfacePort
    } = await this.adminClient!.attachAppInterface({ port: appPortNumber })
    console.log('App Port spun up on port ', appInterfacePort)

    switch (this._backend.type) {
      case 'local':
        const appWsUrl = `ws://${this._backend.machineHost}:${appInterfacePort}`
        this.appClient = await AppWebsocket.connect(
          appWsUrl,
          this._timeout,
          signal => {
            this._onActivity()
            if (this._onSignal !== null) {
              this._onSignal(signal)
            } else {
              console.info('got signal, doing nothing with it: %o', signal)
            }
          }
        )
        this.logger.debug(
          `connectInterfaces :: connected app interface at ${appWsUrl}`
        )
        break
      case 'trycp':
        const backend = this._backend

        await backend.connectAppInterface(appInterfacePort)
        this.appClient = new TunneledAppClient(
          async message => {
            const res = await backend.appInterfaceCall(
              appInterfacePort,
              message
            )
            this._onActivity()
            return res
          },
          () => backend.disconnectAppInterface(appInterfacePort)
        )

        this._appInterfacePort = appInterfacePort

        if (this._onSignal !== null) {
          this._backend.subscribeAppInterfacePort(appInterfacePort, signal =>
            this._onSignal!(signal)
          )
        }
        break
      default:
        const assertNever: never = this._backend
    }
  }
}
