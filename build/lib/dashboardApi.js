"use strict";
async function request(method, dashboardUrl, path, params) {
  const base = dashboardUrl.replace(/\/+$/, "");
  const url = new URL(`${base}/${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }
  const response = await fetch(url.toString(), { method });
  if (!response.ok) {
    const error = new Error(`Dashboard API ${method} /${path} failed: ${response.status} ${response.statusText}`);
    error.status = response.status;
    throw error;
  }
  return await response.json();
}
async function streamLogs(dashboardUrl, path, spawnParams, lineReceivedCb) {
  const wsUrl = `${dashboardUrl.replace(/\/+$/, "").replace(/^http/, "ws")}/${path}`;
  const hasNativeWebSocket = typeof WebSocket !== "undefined";
  let WebSocketImpl;
  if (hasNativeWebSocket) {
    WebSocketImpl = WebSocket;
  } else {
    try {
      WebSocketImpl = require("ws");
    } catch {
      throw new Error(
        'WebSocket streaming requires either Node.js >= 22 with native WebSocket support or the "ws" package installed. Please upgrade Node.js or install "ws" to use compile/upload functionality.'
      );
    }
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocketImpl(wsUrl);
    const settle = (fn) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };
    if (hasNativeWebSocket) {
      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ type: "spawn", ...spawnParams }));
      });
      ws.addEventListener("message", (event) => {
        let data;
        try {
          data = JSON.parse(event.data);
        } catch (error) {
          if (typeof console !== "undefined" && typeof console.debug === "function") {
            console.debug(
              `Failed to parse WebSocket message from /${path}:`,
              error,
              "raw message:",
              event.data
            );
          }
          return;
        }
        const wsEvent = data.event;
        if (wsEvent === "exit") {
          ws.close();
          settle(() => resolve(data.code === 0));
          return;
        }
        if (wsEvent === "line") {
          if (lineReceivedCb) {
            lineReceivedCb(data.data);
          }
        }
      });
      ws.addEventListener("error", (err) => {
        const message = err && typeof err === "object" && typeof err.message === "string" ? err.message : String(err);
        settle(() => reject(new Error(`WebSocket error on /${path}: ${message}`)));
      });
      ws.addEventListener("close", (event) => {
        if (!event.wasClean) {
          settle(() => reject(new Error(`WebSocket closed unexpectedly on /${path}: code ${event.code}`)));
        }
      });
    } else {
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "spawn", ...spawnParams }));
      });
      ws.on("message", (message) => {
        let data;
        try {
          data = JSON.parse(message);
        } catch (error) {
          if (typeof console !== "undefined" && typeof console.debug === "function") {
            console.debug(
              `Failed to parse WebSocket message from /${path}:`,
              error,
              "raw message:",
              message
            );
          }
          return;
        }
        const wsEvent = data.event;
        if (wsEvent === "exit") {
          ws.close();
          settle(() => resolve(data.code === 0));
          return;
        }
        if (wsEvent === "line") {
          if (lineReceivedCb) {
            lineReceivedCb(data.data);
          }
        }
      });
      ws.on("error", (err) => {
        const message = err && err.message ? err.message : String(err);
        settle(() => reject(new Error(`WebSocket error on /${path}: ${message}`)));
      });
      ws.on("close", (code, reason) => {
        if (code !== 1e3) {
          settle(
            () => reject(
              new Error(
                `WebSocket closed unexpectedly on /${path}: code ${code}${reason ? `, reason: ${reason.toString()}` : ""}`
              )
            )
          );
        }
      });
    }
  });
}
async function getDevices(dashboardUrl) {
  return request("GET", dashboardUrl, "devices");
}
async function getConfig(dashboardUrl, configuration) {
  try {
    return await request("GET", dashboardUrl, "json-config", { configuration });
  } catch (error) {
    if (error.status === 404) {
      return null;
    }
    throw error;
  }
}
async function getEncryptionKey(dashboardUrl, configuration) {
  const config = await getConfig(dashboardUrl, configuration);
  if (!config) {
    return null;
  }
  const api = config.api;
  if (!api) {
    return null;
  }
  const encryption = api.encryption;
  if (!encryption) {
    return null;
  }
  return encryption.key || null;
}
async function compile(dashboardUrl, configuration, lineReceivedCb) {
  return streamLogs(dashboardUrl, "compile", { configuration }, lineReceivedCb);
}
async function upload(dashboardUrl, configuration, port, lineReceivedCb) {
  return streamLogs(dashboardUrl, "upload", { configuration, port }, lineReceivedCb);
}
module.exports = {
  request,
  streamLogs,
  getDevices,
  getConfig,
  getEncryptionKey,
  compile,
  upload
};
//# sourceMappingURL=dashboardApi.js.map
