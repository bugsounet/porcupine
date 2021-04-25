/** Porcupine library v1.0.0 **/
/** @bugsounet  **/
/** 2021-04-24  **/

const path = require("path")
const Porcupine = require("@picovoice/porcupine-node")
const { getPlatform } = require("@picovoice/porcupine-node/platforms")
const { BUILTIN_KEYWORDS_STRINGS, BUILTIN_KEYWORDS_STRING_TO_ENUM, getBuiltinKeywordPath } = require("@picovoice/porcupine-node/builtin_keywords")

const PassThrough = require('stream').PassThrough

const PLATFORM_RECORDER_MAP = new Map()
PLATFORM_RECORDER_MAP.set("linux", "arecord")
PLATFORM_RECORDER_MAP.set("mac", "sox")
PLATFORM_RECORDER_MAP.set("raspberry-pi", "arecord")
PLATFORM_RECORDER_MAP.set("windows", "sox")

const Recorder = require("@bugsounet/node-lpcm16")

let log = function() {
    var context = "[PORCUPINE]"
    return Function.prototype.bind.call(console.log, console, context)
}()

class PORCUPINE {
  constructor(config, mic, callback = ()=>{}, debug) {
    this.micConfig = mic
    this.config = config
    this.callback = callback
    this.debug = debug
    if (!this.debug) log = function() { /* do nothing */ }
    log("DetectorConfig:", this.config)

    this.defaultMicOption = {
      recorder: "arecord",
      device: "plughw:1",
      sampleRate: 16000,
      channels: 1,
      threshold: 0.5,
      thresholdStart: null,
      thresholdEnd: null,
      silence: '1.0',
      verbose: false,
      debug: this.debug
    }

    let platform
    try {
      platform = getPlatform()
    } catch (error) {
      console.error("[PORCUPINE] The NodeJS binding does not support this platform. Supported platforms include macOS (x86_64), Windows (x86_64), Linux (x86_64), and Raspberry Pi (1-4)");
      return console.error(error)
    }
    if (this.micConfig.recorder == "auto") {
      let recorderType = PLATFORM_RECORDER_MAP.get(platform)
      console.log(`[PORCUPINE] Platform: '${platform}'; attempting to use '${recorderType}' to access microphone ...`)
      this.micConfig.recorder= recorderType
    }
    this.recorderOptions = Object.assign({}, this.defaultMicOption, this.micConfig)
    log("recorderOptions", this.recorderOptions)

    this.keywordNames= []
    this.running = false
    this.mic= null
  }

  init () {
    let keywordPaths = []
    let libraryFilePath = undefined
    let modelFilePath = undefined 
    let sensitivities = []
    
    /* build keyword list */
    this.config.forEach(detector => {
      if (detector.Model) {
        let keywordString = detector.Model.trim().toLowerCase()
        if (BUILTIN_KEYWORDS_STRINGS.has(keywordString)) {
          keywordPaths.push(
            getBuiltinKeywordPath(
              BUILTIN_KEYWORDS_STRING_TO_ENUM.get(keywordString)
            )
          )
        } else {
          return console.error(`[PORCUPINE] Keyword argument ${detector.Model} is not in the list of built-in keywords`)
        }
      }
      if (detector.Sensitivity == null || isNaN(detector.Sensitivity) || detector.Sensitivity < 0 || detector.Sensitivity > 1) {
        console.error(`[PORCUPINE] ${detector.Model}: Sensitivity must be a number in the range [0,1]`, detector.Sensitivity)
        console.error(`[PORCUPINE] Set Sensitivity for ${detector.Model} to 0.5`)
        sensitivities.push(0.5)
      }
      else sensitivities.push(detector.Sensitivity)
    })

    let keywordPathsDefined = keywordPaths !== undefined

    if (!Array.isArray(keywordPaths)) {
      keywordPaths = keywordPaths.split(",")
    }
    
    for (let keywordPath of keywordPaths) {
      if (keywordPathsDefined && BUILTIN_KEYWORDS_STRINGS.has(keywordPath)) {
        console.warn(`[PORCUPINE] --keyword_path argument '${keywordPath}' matches a built-in keyword. Did you mean to use --keywords ?`)
      }
      let keywordName = keywordPath
        .split(/[\\|\/]/)
        .pop()
        .split("_")[0]
      this.keywordNames.push(keywordName)
    }

    this.porcupine = new Porcupine(keywordPaths, sensitivities, modelFilePath, libraryFilePath)
    log(`Ready for listening this wake word(s): ${this.keywordNames}`)
  }

  async start () {
    if (!this.porcupine) await this.init()
    this.startListening()
    this.running = true
  }

  stop () {
    this.stopListening()
    this.running = false
  }

  /** secondary code **/

  Detector () {
    if (!this.mic) return console.log("[PORCUPINE] Mic not activated!")
    if (!this.porcupine) return console.error("[PORCUPINE] Porpucine is not initialized !")  
    const frameLength = this.porcupine.frameLength
    const sampleRate = this.porcupine.sampleRate
    var frameAccumulator = [];
    this.infoStream.on('data', (data) => {
      //log("Received datas: " + data.length)
      let newFrames16 = new Array(data.length / 2);
      for (let i = 0; i < data.length; i += 2) {
        newFrames16[i / 2] = data.readInt16LE(i);
      }

      frameAccumulator = frameAccumulator.concat(newFrames16);
      let frames = this.chunkArray(frameAccumulator, frameLength);

      if (frames[frames.length - 1].length !== frameLength) {
        frameAccumulator = frames.pop();
      } else {
        frameAccumulator = [];
      }

      for (let frame of frames) {
        if (!this.porcupine) return
        let index = this.porcupine.process(frame)
        if (index !== -1 && this.running) {
          log(`Detected '${this.keywordNames[index]}'`);
          this.callback(this.keywordNames[index])
          this.stopListening()
        }
      }
    })
    this.infoStream.on('error', (error) => {
      log("Error in Info Stream: " + error)
      this.stopListening()
      log("waiting before restarting...")
      setTimeout(() => { this.startListening() }, 10 * 1000)
    })
  }

  error (err,code) {
    if (err || (code == "1")) {
     if (err) console.error("[PORCUPINE][ERROR] " + err)
     this.stop()
     log("Retry restarting...")
     setTimeout(() => { this.start() },2000)
     return
    }
    if (code == "255") {
      this.stop()
      log("Timeout waiting restarting !")
      setTimeout(() => { this.start() }, 1000)
      return
    }
  }

  startListening () {
    if (this.mic) return
    this.mic = null
    this.infoStream = new PassThrough
    this.mic = new Recorder(this.recorderOptions, this.infoStream, (err,code)=>{this.error(err,code)})
    log("Starts listening.")
    this.mic.start()
    this.Detector()
  }

  stopListening () {
    if (!this.mic) return
    this.porcupine.release()
    this.porcupine= null
    this.infoStream = null
    this.keywordNames= []
    this.mic.stop()
    this.mic = null
    log("Stops listening.")
  }
  
  /** Tools **/
  chunkArray (array, size) {
    return Array.from({ length: Math.ceil(array.length / size) }, (v, index) =>
      array.slice(index * size, index * size + size)
    )
  }
}

module.exports = PORCUPINE
