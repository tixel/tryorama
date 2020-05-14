const colors = require('colors/safe')

import { KillFn, ConfigSeedArgs } from "./types";
import { makeLogger } from "./logger";
import { delay } from './util';
import env from './env';
import { connect as legacyConnect } from '@holochain/hc-web-client'
import { AdminWebsocket, AppWebsocket } from '@holochain/conductor-api'
import * as T from './types'

// probably unnecessary, but it can't hurt
// TODO: bump this gradually down to 0 until we can maybe remove it altogether
const WS_CLOSE_DELAY_FUDGE = 500

export type CallAdminFunc = (method: string, params: Record<string, any>) => Promise<any>
export type CallZomeFunc = (instanceId: string, zomeName: string, fnName: string, params: Record<string, any>) => Promise<any>

/**
 * Representation of a running Conductor instance.
 * A [Player] spawns a conductor process locally or remotely and constructs this class accordingly.
 * Though Conductor is spawned externally, this class is responsible for establishing WebSocket
 * connections to the various interfaces to enable zome calls as well as admin and signal handling.
 */
export class Conductor {

  name: string
  onSignal: ({ instanceId: string, signal: Signal }) => void
  logger: any
  kill: KillFn

  _adminWsUrl: string
  _appWsUrl: string
  _isInitialized: boolean
  _rawConfig: T.RawConductorConfig
  _wsClosePromise: Promise<void>
  _onActivity: () => void

  constructor({ name, kill, onSignal, onActivity, appWsUrl, rawConfig }) {
    this.name = name
    this.logger = makeLogger(`tryorama conductor ${name}`)
    this.logger.debug("Conductor constructing")
    this.onSignal = onSignal

    this.kill = async (signal?): Promise<void> => {
      this.logger.debug("Killing...")
      await kill(signal)
      return this._wsClosePromise
    }

    this._adminWsUrl = 'FIXME' // FIXME
    this._appWsUrl = appWsUrl
    this._isInitialized = false
    this._rawConfig = rawConfig
    this._wsClosePromise = Promise.resolve()
    this._onActivity = onActivity
  }

  callAdmin: CallAdminFunc = (...a) => {
    // Not supporting admin functions because currently adding DNAs, instances, etc.
    // is undefined behavior, since the Waiter needs to know about all DNAs in existence,
    // and it's too much of a pain to track all of that with mutable conductor config.
    // If admin functions are added, then a hook must be added as well to update Waiter's
    // NetworkModels as new DNAs and instances are added/removed.
    throw new Error("Admin functions are currently not supported.")
  }

  callZome: CallZomeFunc = (...a) => {
    throw new Error("Attempting to call zome function before conductor was initialized")
  }

  initialize = async () => {
    this._onActivity()
    if (env.legacy) {
      await this._connectInterfaceLegacy()
    } else {
      await this._connectInterfaces()
    }
  }

  awaitClosed = () => this._wsClosePromise

  _connectInterfaces = async () => {
    this._onActivity()

    const adminClient = await AdminWebsocket.connect(this._adminWsUrl)
    this.logger.debug(`connectInterfaces :: connected admin interface at ${this._adminWsUrl}`)

    const appClient = await AppWebsocket.connect(this._appWsUrl, signal => {
      // TODO: do something meaningful with signals
      this.logger.info("received app signal: %o", signal)
    })
    this.logger.debug(`connectInterfaces :: connected app interface at ${this._appWsUrl}`)

    this.callZome = (instanceId, zomeName, fnName, payload) => {

      const cellId = cellIdFromInstanceId(this._rawConfig, instanceId)

      return appClient.callZome({
        cell_id: cellId,
        zome_name: zomeName,
        cap: 'TODO',
        fn_name: fnName,
        payload: payload,
        provenance: 'TODO'
      })
    }

    // TODO: hook up callAdmin
  }

  _connectInterfaceLegacy = async () => {
    this._onActivity()
    const url = this._adminWsUrl
    this.logger.debug(`connectInterface :: connecting to ${url}`)
    const { call, callZome, onSignal, ws } = await legacyConnect({ url })
    this.logger.debug(`connectInterface :: connected to ${url}`)

    this._wsClosePromise = (
      // Wait for a constant delay and for websocket to close, whichever happens *last*
      Promise.all([
        new Promise(resolve => ws.on('close', resolve)),
        delay(WS_CLOSE_DELAY_FUDGE),
      ]).then(() => { })
    )

    this.callAdmin = async (method, params) => {
      this._onActivity()
      if (!method.match(/^admin\/.*\/list$/)) {
        this.logger.warn("Calling admin functions which modify state during tests may result in unexpected behavior!")
      }
      this.logger.debug(`${colors.yellow.bold("[setup call on %s]:")} ${colors.yellow.underline("%s")}`, this.name, method)
      this.logger.debug(JSON.stringify(params, null, 2))
      const result = await call(method)(params)
      this.logger.debug(`${colors.yellow.bold('-> %o')}`, result)
      return result
    }

    onSignal(data => {
      const { signal, instance_id } = data
      this.logger.silly('onSignal:', data)
      if (!signal || signal.signal_type !== 'Consistency') {
        // not a consistency signal, or some other kind of data being sent down the pipe
        return
      }

      this._onActivity()

      this.onSignal({
        instanceId: instance_id,
        signal
      })
    })

    this.callZome = (instanceId, zomeName, fnName, params) => new Promise((resolve, reject) => {
      this._onActivity()
      this.logger.debug(`${colors.cyan.bold("zome call [%s]:")} ${colors.cyan.underline("{id: %s, zome: %s, fn: %s}")}`,
        this.name, instanceId, zomeName, fnName
      )
      this.logger.debug(`${colors.cyan.bold("params:")} ${colors.cyan.underline("%s")}`, JSON.stringify(params, null, 2))
      const timeoutSoft = env.zomeCallTimeoutMs / 2
      const timeoutHard = env.zomeCallTimeoutMs
      const callInfo = `${zomeName}/${fnName}`
      const timerSoft = setTimeout(
        () => this.logger.warn(`Zome call '${callInfo}' has been running for more than ${timeoutSoft / 1000} seconds. Continuing to wait...`),
        timeoutSoft
      )
      const timerHard = setTimeout(
        () => {
          const msg = `zome call timed out after ${timeoutHard / 1000} seconds on conductor '${this.name}': ${instanceId}/${zomeName}/${fnName}`
          if (env.stateDumpOnError) {
            this.callAdmin('debug/state_dump', { instance_id: instanceId }).then(dump => {
              this.logger.error("STATE DUMP:")
              this.logger.error(JSON.stringify(dump, null, 2))
            }).catch(err => this.logger.error("Error while calling debug/state_dump: %o", err))
              .then(() => reject(msg))
          } else {
            reject(msg)
          }
        },
        timeoutHard
      )
      callZome(instanceId, zomeName, fnName)(params).then(json => {
        this._onActivity()
        const result = JSON.parse(json)
        this.logger.debug(`${colors.cyan.bold('->')} %o`, result)
        resolve(result)
      })
        .catch(reject)
        .finally(() => {
          clearTimeout(timerSoft)
          clearTimeout(timerHard)
        })
    })
  }
}


export const cellIdFromInstanceId = (config: T.RawConductorConfig, instanceId: string): T.CellId => {
  const instance = config.instances.find(i => i.id === instanceId)!
  const dnaHash = config.dnas.find(d => d.id === instance.dna)!.hash!
  const agentKey = config.agents.find(a => a.id === instance.agent)!.public_address
  return [dnaHash, agentKey]
}
