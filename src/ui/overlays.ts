import * as Option from "effect/Option";
import { modifyFields } from "foldkit/struct";
import * as Update from "foldkit/update";
import * as Combobox from "./components/ui/combobox.ts";
import * as Popover from "./components/ui/popover.ts";
import { Message } from "./message.ts";
import type { Model } from "./model.ts";

const foldPopoverOutMessage = Popover.OutMessage.match<Update.Step<Model, Message>>({
  Opened: () => (model) => ({ model }),
  Closed: () => (model) => ({ model }),
});
export const closeThreadPopover = Update.foldChildStep({
  update: Popover.close,
  read: (model: Model) => Option.some(model.threadPopover),
  write: (model, nextThreadPopover) =>
    modifyFields(model, { threadPopover: () => nextThreadPopover }),
  toParentMessage: (message) => Message.GotThreadPopoverMessage({ message }),
  foldOutMessage: foldPopoverOutMessage,
});
export const closeWorkspacePopover = Update.foldChildStep({
  update: Popover.close,
  read: (model: Model) => Option.some(model.workspacePopover),
  write: (model, nextWorkspacePopover) =>
    modifyFields(model, { workspacePopover: () => nextWorkspacePopover }),
  toParentMessage: (message) => Message.GotWorkspacePopoverMessage({ message }),
  foldOutMessage: foldPopoverOutMessage,
});
export const closeSettingsPopover = Update.foldChildStep({
  update: Popover.close,
  read: (model: Model) => Option.some(model.settingsPopover),
  write: (model, nextSettingsPopover) =>
    modifyFields(model, { settingsPopover: () => nextSettingsPopover }),
  toParentMessage: (message) => Message.GotSettingsPopoverMessage({ message }),
  foldOutMessage: Popover.OutMessage.match<Update.Step<Model, Message>>({
    Opened: () => (model) => ({ model }),
    Closed: () => (model) => ({
      model: modifyFields(model, {
        modelCombobox: () =>
          Combobox.init({ id: "model", isAnimated: false, selectInputOnFocus: true }),
      }),
    }),
  }),
});
