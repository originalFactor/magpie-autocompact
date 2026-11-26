export function restorations(prefix) {
  const tools = prefix.filter((x) => x.type === "additional_tools"
    || (["system", "developer"].includes(x.role) && [undefined, "message"].includes(x.type)));
  const update = { type: "configuration_update" };
  for (const item of prefix) {
    if (item.type !== "configuration_update") continue;
    if (item.reasoning?.effort !== undefined) update.reasoning = { effort: item.reasoning.effort };
    if (item.text?.format !== undefined) update.text = { format: item.text.format };
  }
  return [...tools, ...(Object.keys(update).length > 1 ? [update] : [])];
}
