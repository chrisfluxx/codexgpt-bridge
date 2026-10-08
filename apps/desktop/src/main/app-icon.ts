import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeImage, type NativeImage } from "electron";

const iconPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "renderer",
  "bridge-icon.png",
);

export function bridgeAppIcon(): NativeImage {
  const image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) throw new Error("Bridge app icon could not be loaded.");
  return image;
}
