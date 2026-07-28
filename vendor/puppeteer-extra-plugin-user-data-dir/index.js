'use strict'

// xposter vendor patch (GHSA-mh99-v99m-4gvg):
//
// Upstream berstend/puppeteer-extra-plugin-user-data-dir@2.4.1 (latest
// published version as of this patch; verified via `npm view ... versions`)
// unconditionally depends on rimraf@^3.0.2, which pulls glob@7 ->
// minimatch@3 -> brace-expansion@1.1.16 (unbounded brace-expansion DoS).
// No newer version of this package, puppeteer-extra-plugin-user-preferences,
// or puppeteer-extra-plugin-stealth drops that dependency, and the patched
// brace-expansion@5.0.8 is API-incompatible with minimatch@3 (object export
// vs. callable export), so it cannot be fixed with an override alone.
//
// The only thing rimraf did here was delete a directory tree with a few
// retries if Chrome still had a handle on it (see deleteUserDataDir below).
// Node's own fs.rm has supported that exact retry/force/recursive contract
// natively since Node 14.14 (Electron 30 embeds Node 20), so this patch
// swaps the one call site and drops the rimraf dependency entirely. No
// other behavior, and no public API of this package, changes.
//
// Original work Copyright (c) 2019 berstend <github@berstend.com>, MIT
// License (see ./LICENSE, unmodified).
const util = require('util')
const fs = require('fs')
const fse = require('fs-extra')
const os = require('os')
const path = require('path')
const debug = require('debug')('puppeteer-extra-plugin:user-data-dir')
const mkdtempAsync = util.promisify(fs.mkdtemp)
const { PuppeteerExtraPlugin } = require('puppeteer-extra-plugin')

/**
 *
 * Further reading:
 * https://chromium.googlesource.com/chromium/src/+/master/docs/user_data_dir.md
 */
class Plugin extends PuppeteerExtraPlugin {
  constructor(opts = {}) {
    super(opts)

    this._userDataDir = null
    this._isTemporary = false

    const defaults = {
      deleteTemporary: true,
      deleteExisting: false,
      files: []
    }
    // Follow Puppeteers temporary user data dir naming convention by default
    defaults.folderPath = os.tmpdir()
    defaults.folderPrefix = 'puppeteer_dev_profile-'

    this._opts = Object.assign(defaults, opts)
    debug('initialized', this._opts)
  }

  get name() {
    return 'user-data-dir'
  }

  get requirements() {
    return new Set(['runLast', 'dataFromPlugins'])
  }

  get shouldDeleteDirectory() {
    if (this._isTemporary && this._opts.deleteTemporary) {
      return true
    }
    return this._opts.deleteExisting
  }

  get temporaryDirectoryPath() {
    return path.join(this._opts.folderPath, this._opts.folderPrefix)
  }

  get defaultProfilePath() {
    return path.join(this._userDataDir, 'Default')
  }

  async makeTemporaryDirectory() {
    this._userDataDir = await mkdtempAsync(this.temporaryDirectoryPath)
    this._isTemporary = true
  }

  deleteUserDataDir() {
    debug('removeUserDataDir', this._userDataDir)

    if (!this._userDataDir) {
      debug('No userDataDir, not running fs.rm')
      return
    }

    // fs.rm's maxRetries/recursive/force options reproduce rimraf's original
    // maxBusyTries=4 behavior (retry a few times if Chrome still has the
    // directory open, then give up without throwing).
    fs.rm(
      this._userDataDir,
      {
        recursive: true,
        force: true,
        maxRetries: 4
      },
      err => {
        debug(err)
      }
    )
  }

  async writeFilesToProfile() {
    const filesFromPlugins = this.getDataFromPlugins('userDataDirFile').map(
      d => d.value
    )
    const files = [].concat(filesFromPlugins, this._opts.files)
    if (!files.length) {
      return
    }
    for (const file of files) {
      if (file.target !== 'Profile') {
        console.warn(`Warning: Ignoring file with invalid target`, file)
        continue
      }
      const filePath = path.join(this.defaultProfilePath, file.file)
      try {
        await fse.outputFile(filePath, file.contents)
        debug(`Wrote file`, filePath)
      } catch (err) {
        console.warn('Warning: Failure writing file', filePath, file, err)
      }
    }
  }

  async beforeLaunch(options) {
    this._userDataDir = options.userDataDir
    if (!this._userDataDir) {
      await this.makeTemporaryDirectory()
      options.userDataDir = this._userDataDir
      debug('created custom dir', options.userDataDir)
    }
    await this.writeFilesToProfile()
  }

  async onDisconnected() {
    debug('onDisconnected')
    if (this.shouldDeleteDirectory) {
      this.deleteUserDataDir()
    }
  }
}

module.exports = function(pluginConfig) {
  return new Plugin(pluginConfig)
}
