const sinon = require('sinon')
const test = require('tape')
const TOML = require('@iarna/toml')

import * as T from '../../src/types'
import * as C from '../../src/config';
import { genConfigArgs } from '../common';

export const { configPlain, configSugared } = (() => {
  const dna = C.dna('path/to/dna.json', 'dna-id', { uuid: 'uuid' })
  const common = {
    bridges: [C.bridge('b', 'alice', 'bob')],
    dpki: C.dpki('alice', { well: 'hello' }),
  }
  const instancesSugared = {
    alice: dna,
    bob: dna,
  }
  const instancesDesugared: Array<T.InstanceConfig> = [
    {
      id: 'alice',
      agent: {
        id: 'name::alice',
        name: 'name::alice',
        keystore_file: 'name::alice',
        public_address: 'name::alice',
        test_agent: true,
      },
      dna: {
        id: 'dna-id',
        file: 'path/to/dna.json',
        uuid: 'uuid'
      }
    },
    {
      id: 'bob',
      agent: {
        id: 'name::bob',
        name: 'name::bob',
        keystore_file: 'name::bob',
        public_address: 'name::bob',
        test_agent: true,
      },
      dna: {
        id: 'dna-id',
        file: 'path/to/dna.json',
        uuid: 'uuid'
      }
    }
  ]
  const configSugared = Object.assign({}, common, { instances: instancesSugared })
  const configPlain = Object.assign({}, common, { instances: instancesDesugared })
  return { configPlain, configSugared }
})()

const configEmpty: T.ConductorConfig = {
  instances: []
}

test('DNA id generation', t => {
  t.equal(C.dnaPathToId('path/to/file'), 'file')
  t.equal(C.dnaPathToId('path/to/file.dna'), 'file.dna')
  t.equal(C.dnaPathToId('path/to/file.json'), 'file.json')
  t.equal(C.dnaPathToId('path/to/file.dna.json'), 'file')

  t.equal(C.dnaPathToId('file'), 'file')
  t.equal(C.dnaPathToId('file.json'), 'file.json')
  t.equal(C.dnaPathToId('file.dna.json'), 'file')
  t.end()
})

test('Sugared config', async t => {
  t.deepEqual(C.desugarConfig('name', configSugared), configPlain)
  t.end()
})

test('genInstanceConfig', async t => {
  const stubGetDnaHash = sinon.stub(C, 'getDnaHash').resolves('fakehash')
  const { agents, dnas, instances, interfaces } = await C.genInstanceConfig(configPlain, await genConfigArgs())
  t.equal(agents.length, 2)
  t.equal(dnas.length, 1)
  t.equal(instances.length, 2)
  t.equal(interfaces.length, 2)
  t.ok(interfaces[0].admin, true)
  t.equal(interfaces[0].instances.length, 0)
  t.notOk(interfaces[1].admin)
  t.equal(interfaces[1].instances.length, 2)
  t.end()
  stubGetDnaHash.restore()
})

test('genBridgeConfig', async t => {
  const { bridges } = await C.genBridgeConfig(configPlain)
  t.deepEqual(bridges, [{ handle: 'b', caller_id: 'alice', callee_id: 'bob' }])
  t.end()
})

test('genBridgeConfig, empty', async t => {
  const json = await C.genBridgeConfig(configEmpty)
  t.notOk('bridges' in json)
  t.end()
})

test('genDpkiConfig', async t => {
  const { dpki } = await C.genDpkiConfig(configPlain)
  t.deepEqual(dpki, { instance_id: 'alice', init_params: { "well": "hello" } })
  t.end()
})

test('genDpkiConfig, empty', async t => {
  const json = await C.genDpkiConfig(configEmpty)
  t.notOk('dpki' in json)
  t.end()
})

test('genSignalConfig', async t => {
  const { signals } = await C.genSignalConfig(configPlain)
  t.ok('trace' in signals)
  t.ok('consistency' in signals)
  t.equal(signals.consistency, true)
  t.end()
})

test.skip('genNetworkConfig', async t => {
  t.fail("TODO")
  t.end()
})

test('genLoggingConfig', async t => {
  const loggerVerbose = await C.genLoggingConfig(true)
  const loggerQuiet = await C.genLoggingConfig(false)

  const expectedVerbose = TOML.parse(`
[logger]
type = "debug"
state_dump = true
[[logger.rules.rules]]
exclude = false
pattern = ".*"
  `)

  const expectedQuiet = TOML.parse(`
[logger]
type = "debug"
state_dump = false
[[logger.rules.rules]]
exclude = true
pattern = ".*"
  `)

  t.deepEqual(loggerVerbose, expectedVerbose)
  t.deepEqual(loggerQuiet, expectedQuiet)
  t.end()
})

test('genConfig produces valid TOML', async t => {
  const stubGetDnaHash = sinon.stub(C, 'getDnaHash').resolves('fakehash')
  const builder = C.genConfig(configSugared)
  const toml = await builder({ configDir: 'dir', adminPort: 1111, zomePort: 2222, uuid: 'uuid', conductorName: 'conductorName' })
  const json = TOML.parse(toml)
  const toml2 = TOML.stringify(json)
  t.equal(toml, toml2)
  t.end()
  stubGetDnaHash.restore()
})