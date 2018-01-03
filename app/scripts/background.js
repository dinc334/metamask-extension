const urlUtil = require('url')
const endOfStream = require('end-of-stream')
const pump = require('pump')
const log = require('loglevel')
const extension = require('extensionizer')
const LocalStorageStore = require('obs-store/lib/localStorage')
const ExtensionStore = require('./lib/extension-store')
const storeTransform = require('obs-store/lib/transform')
const asStream = require('obs-store/lib/asStream')
const ExtensionPlatform = require('./platforms/extension')
const Migrator = require('./lib/migrator/')
const migrations = require('./migrations/')
const PortStream = require('./lib/port-stream.js')
const NotificationManager = require('./lib/notification-manager.js')
const MetamaskController = require('./metamask-controller')
const firstTimeState = require('./first-time-state')

const STORAGE_KEY = 'metamask-config'
const METAMASK_DEBUG = 'GULP_METAMASK_DEBUG'

window.log = log
log.setDefaultLevel(METAMASK_DEBUG ? 'debug' : 'warn')

const platform = new ExtensionPlatform()
const notificationManager = new NotificationManager()
global.METAMASK_NOTIFIER = notificationManager

let popupIsOpen = false

// state persistence
const diskStore = new LocalStorageStore({ storageKey: STORAGE_KEY })
const extensionStore = new ExtensionStore()

// initialization flow
initialize().catch(log.error)

async function initialize () {
  const initState = await loadStateFromPersistence()
  await setupController(initState)
  log.debug('MetaMask initialization complete.')
}

//
// State and Persistence
//

async function loadStateFromPersistence () {
  // migrations
  const migrator = new Migrator({ migrations })
  // read from disk
  let versionedData = diskStore.getState() || migrator.generateInitialState(firstTimeState)
  // fetch from extension store and merge in data

  if (extensionStore.isSupported && extensionStore.isEnabled) {
    const extensionData = await extensionStore.fetch() // TODO: handle possible exceptions (https://developer.chrome.com/apps/runtime#property-lastError)
    versionedData = { ...versionedData, ...extensionData }
  }

  // migrate data
  versionedData = await migrator.migrateData(versionedData)
  // write to disk
  diskStore.putState(versionedData)
  // return just the data
  return versionedData.data
}

function setupController (initState) {
  //
  // MetaMask Controller
  //

  const controller = new MetamaskController({
    // User confirmation callbacks:
    showUnconfirmedMessage: triggerUi,
    unlockAccountMessage: triggerUi,
    showUnapprovedTx: triggerUi,
    // initial state
    initState,
    // platform specific api
    platform,
  })
  global.metamaskController = controller

  // setup state persistence
  pump(
    asStream(controller.store),
    storeTransform(versionifyData),
    storeTransform(syncDataWithExtension),
    asStream(diskStore)
  )

  function versionifyData (state) {
    const versionedData = diskStore.getState()
    versionedData.data = state
    return versionedData
  }

  function syncDataWithExtension(state) {
    if (extensionStore.isSupported && extensionStore.isEnabled) {
      extensionStore.sync(state) // TODO: handle possible exceptions (https://developer.chrome.com/apps/runtime#property-lastError)
    }
    return state
  }

  //
  // connect to other contexts
  //

  extension.runtime.onConnect.addListener(connectRemote)
  function connectRemote (remotePort) {
    const isMetaMaskInternalProcess = remotePort.name === 'popup' || remotePort.name === 'notification'
    const portStream = new PortStream(remotePort)
    if (isMetaMaskInternalProcess) {
      // communication with popup
      popupIsOpen = popupIsOpen || (remotePort.name === 'popup')
      controller.setupTrustedCommunication(portStream, 'MetaMask')
      // record popup as closed
      if (remotePort.name === 'popup') {
        endOfStream(portStream, () => {
          popupIsOpen = false
        })
      }
    } else {
      // communication with page
      const originDomain = urlUtil.parse(remotePort.sender.url).hostname
      controller.setupUntrustedCommunication(portStream, originDomain)
    }
  }

  //
  // User Interface setup
  //

  updateBadge()
  controller.txController.on('update:badge', updateBadge)
  controller.messageManager.on('updateBadge', updateBadge)
  controller.personalMessageManager.on('updateBadge', updateBadge)

  // plugin badge text
  function updateBadge () {
    var label = ''
    var unapprovedTxCount = controller.txController.getUnapprovedTxCount()
    var unapprovedMsgCount = controller.messageManager.unapprovedMsgCount
    var unapprovedPersonalMsgs = controller.personalMessageManager.unapprovedPersonalMsgCount
    var unapprovedTypedMsgs = controller.typedMessageManager.unapprovedTypedMessagesCount
    var count = unapprovedTxCount + unapprovedMsgCount + unapprovedPersonalMsgs + unapprovedTypedMsgs
    if (count) {
      label = String(count)
    }
    extension.browserAction.setBadgeText({ text: label })
    extension.browserAction.setBadgeBackgroundColor({ color: '#506F8B' })
  }

  return Promise.resolve()
}

//
// Etc...
//

// popup trigger
function triggerUi () {
  if (!popupIsOpen) notificationManager.showPopup()
}

// On first install, open a window to MetaMask website to how-it-works.
extension.runtime.onInstalled.addListener(function (details) {
  if ((details.reason === 'install') && (!METAMASK_DEBUG)) {
    extension.tabs.create({url: 'https://metamask.io/#how-it-works'})
  }
})
