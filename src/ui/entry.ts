import { Runtime } from "foldkit";
import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import * as Layer from "effect/Layer";
import { init, Message, Model, subscriptions, update, view } from "./main.ts";
import { ChatWorkflow } from "./workflow.ts";
import "@fontsource-variable/inter";
import "@fontsource/ibm-plex-mono/400.css";
import "./styles.css";

const application = Runtime.makeApplication({
  Model,
  init,
  update,
  view,
  subscriptions,
  resources: Layer.merge(ChatWorkflow.layer, BrowserCrypto.layer),
  container: document.getElementById("root"),
  devTools: { Message },
});

Runtime.run(application);
