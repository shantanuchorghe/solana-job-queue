"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("./polyfills");
const react_1 = require("react");
const client_1 = require("react-dom/client");
const App_1 = __importDefault(require("./App"));
const rootElement = document.getElementById("root");
if (!rootElement) {
    throw new Error("Root element #root was not found");
}
(0, client_1.createRoot)(rootElement).render(<react_1.StrictMode>
    <App_1.default />
  </react_1.StrictMode>);
