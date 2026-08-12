"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var preload_exports = {};
module.exports = __toCommonJS(preload_exports);
var import_electron = require("electron");
const api = {
  console: {
    // 订阅后台日志（main 进程转发的 event:log）
    onLog: (callback) => {
      const sub = (_e, ...args) => callback(...args);
      import_electron.ipcRenderer.on("event:log", sub);
      return () => import_electron.ipcRenderer.removeListener("event:log", sub);
    },
    getRecent: () => import_electron.ipcRenderer.invoke("console:getRecent")
  },
  server: {
    restart: () => import_electron.ipcRenderer.invoke("server:restart")
  },
  system: {
    getInfo: () => import_electron.ipcRenderer.invoke("system:get-info")
  }
};
import_electron.contextBridge.exposeInMainWorld("fbclaw", api);
