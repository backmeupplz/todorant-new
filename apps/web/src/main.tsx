import { render } from "preact";
import { App } from "./app.js";
import "./styles.css";

const root = document.getElementById("app");
if (!root) throw new Error("Application root is missing");
render(<App />, root);
