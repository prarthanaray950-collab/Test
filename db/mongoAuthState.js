/**
 * mongoAuthState.js
 * Saves Baileys WhatsApp session credentials to MongoDB.
 * Replaces the default file-based auth — session persists across restarts.
 *
 * FIX: Use Baileys' own initAuthCreds() + BufferJSON serializer.
 * The old custom initAuthCreds() used raw randomBytes() Buffers with the
 * wrong shape → Baileys sent a malformed handshake → server rejected with
 * code 428 (stream error) before the QR was ever generated.
 * BufferJSON ensures Buffer values survive JSON.stringify/parse correctly.
 */

const mongoose = require("mongoose");
const {
  initAuthCreds,
  BufferJSON,
} = require("@whiskeysockets/baileys");

const authSchema = new mongoose.Schema({
  key:   { type: String, required: true, unique: true },
  value: { type: String, required: true },  // stored as serialized JSON string
}, { timestamps: true });

const AuthModel = mongoose.models.BaileysAuth
  || mongoose.model("BaileysAuth", authSchema);

const useMongoAuthState = async () => {

  const writeData = async (key, value) => {
    await AuthModel.findOneAndUpdate(
      { key },
      { key, value: JSON.stringify(value, BufferJSON.replacer) },
      { upsert: true, new: true }
    );
  };

  const readData = async (key) => {
    const doc = await AuthModel.findOne({ key });
    if (!doc) return null;
    return JSON.parse(doc.value, BufferJSON.reviver);
  };

  const removeData = async (key) => {
    await AuthModel.deleteOne({ key });
  };

  // Load existing creds — or start fresh with the correct Baileys shape
  const creds = (await readData("creds")) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            const val = await readData(`${type}-${id}`);
            if (val !== null) data[id] = val;
          }
          return data;
        },
        set: async (data) => {
          for (const [type, values] of Object.entries(data)) {
            for (const [id, value] of Object.entries(values || {})) {
              if (value != null) {
                await writeData(`${type}-${id}`, value);
              } else {
                await removeData(`${type}-${id}`);
              }
            }
          }
        },
      },
    },
    saveCreds: async () => {
      await writeData("creds", creds);
      console.log("[MongoAuth] ✅ Credentials saved to MongoDB");
    },
  };
};

module.exports = { useMongoAuthState };
