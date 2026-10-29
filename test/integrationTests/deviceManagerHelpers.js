/**
 * Helpers to talk to the adapter like the admin UI / device manager does
 */

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

module.exports = { NAMESPACE, sendToAdapter, addDeviceWithDeviceManager };
