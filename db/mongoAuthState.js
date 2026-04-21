/**
 * mongoAuthState.js
 * Saves Baileys WhatsApp session credentials to MongoDB.
 * Replaces the default file-based auth — session persists across restarts.
 */

const mongoose = require("mongoose");

const authSchema = new mongoose.Schema({
  key:   { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed, required: true },
}, { timestamps: true });

const AuthModel = mongoose.models.BaileysAuth
  || mongoose.model("BaileysAuth", authSchema);

/**
 * Baileys-compatible MongoDB auth state
 * Returns { state, saveCreds }
 */
const useMongoAuthState = async () => {

  const writeData = async (key, value) => {
    await AuthModel.findOneAndUpdate(
      { key },
      { key, value: JSON.parse(JSON.stringify(value)) },
      { upsert: true, new: true }
    );
  };

  const readData = async (key) => {
    const doc = await AuthModel.findOne({ key });
    return doc ? doc.value : null;
  };

  const removeData = async (key) => {
    await AuthModel.deleteOne({ key });
  };

  // Load existing creds
  const creds = await readData("creds") || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            const val = await readData(`${type}-${id}`);
            if (val) data[id] = val;
          }
          return data;
        },
        set: async (data) => {
          for (const [type, values] of Object.entries(data)) {
            for (const [id, value] of Object.entries(values || {})) {
              if (value) {
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

/**
 * Initialize empty credentials (same as Baileys default)
 */
const initAuthCreds = () => {
  const { randomBytes } = require("crypto");
  return {
    noiseKey: { private: randomBytes(32), public: randomBytes(32) },
    signedIdentityKey: { private: randomBytes(32), public: randomBytes(32) },
    signedPreKey: {
      keyPair: { private: randomBytes(32), public: randomBytes(32) },
      signature: randomBytes(64),
      keyId: 1,
    },
    registrationId: Math.floor(Math.random() * 16383) + 1,
    advSecretKey: randomBytes(32).toString("base64"),
    processedHistoryMessages: [],
    nextPreKeyId: 1,
    firstUnuploadedPreKeyId: 1,
    accountSyncCounter: 0,
    accountSettings: { unarchiveChats: false },
    registered: false,
    pairingEphemeralKeyPair: { private: randomBytes(32), public: randomBytes(32) },
    me: undefined,
    account: undefined,
    signalIdentities: [],
  };
};

module.exports = { useMongoAuthState };
