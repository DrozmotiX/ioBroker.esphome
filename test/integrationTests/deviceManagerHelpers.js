/**
 * Helpers to talk to the adapter like the admin UI / device manager does
 */

const crypto = require('node:crypto');

const NAMESPACE = 'esphome.0';

/**
 * Sends a message to the adapter and resolves with its answer
 *
 * @param {object} harness - Integration test harness
 * @param {string} command - Message command
 * @param {object} message - Message payload
 * @param {number} [timeoutMs] - How long to wait for the answer
 * @returns {Promise<any>} The answer of the adapter
 */
function sendToAdapter(harness, command, message, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`No answer to "${command}" within ${timeoutMs}ms`)), timeoutMs);
        harness.sendTo(NAMESPACE, command, message, response => {
            clearTimeout(timer);
            resolve(response);
        });
    });
}

/**
 * Adds a device the way a user does in the device manager: the "Add device" instance action asks for
 * IP address and credentials in a form, shows a progress dialog while connecting and then a message
 * with the result. Every step is answered like the GUI does with a "dm:actionProgress" message.
 *
 * @param {object} harness - Integration test harness
 * @param {object} form - Data entered in the form (ip, encryptionKey, apiPassword)
 * @returns {Promise<{messages: string[], result: object}>} Texts shown to the user and final result
 */
async function addDeviceWithDeviceManager(harness, form) {
    // The device manager always asks for the instance info first, actions are only accepted afterwards
    await sendToAdapter(harness, 'dm:instanceInfo', {});

    const messages = [];
    let response = await sendToAdapter(harness, 'dm:instanceAction', { actionId: 'add' });
    while (response.type !== 'result') {
        let answer = {};
        if (response.type === 'form') {
            answer = { data: form };
        } else if (response.type === 'message') {
            messages.push(response.message);
        } else if (response.type !== 'progress') {
            throw new Error(`Unexpected device manager response ${JSON.stringify(response)}`);
        }
        // Connecting can take until the progress dialog closes, up to 30 s
        response = await sendToAdapter(harness, 'dm:actionProgress', { origin: response.origin, ...answer }, 60000);
    }
    return { messages, result: response.result };
}

/**
 * Encrypts a value like adapter.encrypt() does (js-controller tools.encrypt with the secret of system.config),
 * to write credentials the way earlier adapter versions stored them in the device objects
 *
 * @param {object} harness - Integration test harness
 * @param {string} value - Value to encrypt
 * @returns {Promise<string>} The encrypted value
 */
async function encryptLikeAdapter(harness, value) {
    const systemConfig = await harness.objects.getObjectAsync('system.config');
    const secret = systemConfig.native.secret;
    if (!/^[0-9a-f]{48}$/.test(secret)) {
        // Legacy secret
        let result = '';
        for (let i = 0; i < value.length; i++) {
            result += String.fromCharCode(secret[i % secret.length].charCodeAt(0) ^ value.charCodeAt(i));
        }
        return result;
    }
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-192-cbc', Buffer.from(secret, 'hex'), iv);
    const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
    return `$/aes-192-cbc:${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

module.exports = { NAMESPACE, sendToAdapter, addDeviceWithDeviceManager, encryptLikeAdapter };
