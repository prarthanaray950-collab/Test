/**
 * voiceProcessor.js
 *
 * Voice note transcription using local Whisper (no paid API).
 *
 * SETUP (run once on your server):
 *   npm install @xenova/transformers    # Whisper in Node.js, no Python needed
 *   npm install fluent-ffmpeg ffmpeg-static  # audio conversion
 *
 * HOW IT WORKS:
 *   1. Baileys downloads the audio from WhatsApp (OGG/OPUS format)
 *   2. ffmpeg converts OGG → WAV (16kHz mono, required by Whisper)
 *   3. Whisper transcribes WAV → text (works offline, no API key)
 *   4. Text is passed back to handleMessage as if customer typed it
 *
 * LIMITATIONS:
 *   - First run downloads ~150MB Whisper model (cached after that)
 *   - Takes 3-15 seconds depending on audio length and CPU
 *   - Hinglish accuracy is good but not perfect
 *   - Requires ~500MB RAM during transcription
 *   - Not suitable for very long audio (>30 seconds)
 *
 * RENDER NOTE:
 *   Render free tier has limited disk. Use whisper "tiny" or "base" model.
 *   Set WHISPER_MODEL=Xenova/whisper-tiny in your .env for fastest speed.
 */

const path = require("path");
const fs   = require("fs");
const os   = require("os");

let pipeline = null;
let _available = false;

// Check if required packages are installed
const checkAvailability = () => {
  try {
    require.resolve("@xenova/transformers");
    require.resolve("fluent-ffmpeg");
    _available = true;
    console.log("[Voice] Whisper transcription available.");
  } catch (_) {
    _available = false;
    console.log("[Voice] Whisper not available. Install: npm install @xenova/transformers fluent-ffmpeg ffmpeg-static");
  }
  return _available;
};

const isAvailable = () => _available;

// Lazy-load the Whisper pipeline (downloads model on first use)
const getPipeline = async () => {
  if (pipeline) return pipeline;
  const { pipeline: createPipeline } = require("@xenova/transformers");
  const model = process.env.WHISPER_MODEL || "Xenova/whisper-small"; // or whisper-tiny for speed
  console.log("[Voice] Loading Whisper model: " + model + " (first time may take a minute)...");
  pipeline = await createPipeline("automatic-speech-recognition", model, {
    quantized: true, // smaller/faster quantized model
  });
  console.log("[Voice] Whisper model loaded.");
  return pipeline;
};

// Convert OGG/OPUS to WAV using ffmpeg
const convertToWav = (inputPath, outputPath) => {
  return new Promise((resolve, reject) => {
    const ffmpeg = require("fluent-ffmpeg");
    try {
      // Use bundled ffmpeg if available
      const ffmpegStatic = require("ffmpeg-static");
      ffmpeg.setFfmpegPath(ffmpegStatic);
    } catch (_) {}

    ffmpeg(inputPath)
      .audioChannels(1)      // mono
      .audioFrequency(16000) // 16kHz required by Whisper
      .audioCodec("pcm_s16le")
      .format("wav")
      .on("end", resolve)
      .on("error", reject)
      .save(outputPath);
  });
};

// Download audio from a Baileys message
const downloadAudio = async (msg, sock) => {
  const { downloadMediaMessage } = require("@whiskeysockets/baileys");
  const buffer = await downloadMediaMessage(msg, "buffer", {}, { logger: { level: "silent" }, reuploadRequest: sock.updateMediaMessage });
  const tmpIn  = path.join(os.tmpdir(), "sv_audio_" + Date.now() + ".ogg");
  fs.writeFileSync(tmpIn, buffer);
  return tmpIn;
};

// Main transcription function
const transcribe = async (msg, sock) => {
  if (!_available) return null;

  const tmpIn  = await downloadAudio(msg, sock);
  const tmpOut = tmpIn.replace(".ogg", ".wav");

  try {
    // Convert OGG to WAV
    await convertToWav(tmpIn, tmpOut);

    // Transcribe with Whisper
    const asr    = await getPipeline();
    const result = await asr(tmpOut, {
      language:             "hi",    // Hindi — handles Hinglish well
      task:                 "transcribe",
      chunk_length_s:       30,
      stride_length_s:      5,
      return_timestamps:    false,
    });

    const text = (result.text || "").trim();
    console.log("[Voice] Transcribed: " + text.slice(0, 80));
    return text || null;

  } catch (e) {
    console.error("[Voice] Transcription failed:", e.message);
    return null;
  } finally {
    // Clean up temp files
    try { fs.unlinkSync(tmpIn);  } catch (_) {}
    try { fs.unlinkSync(tmpOut); } catch (_) {}
  }
};

// Run availability check on module load
checkAvailability();

module.exports = { isAvailable, transcribe };
