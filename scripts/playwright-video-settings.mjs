import { readFileSync } from "node:fs";

const settingsPath = new URL("../playwright-video-dimensions.json", import.meta.url);
const settings = JSON.parse(readFileSync(settingsPath, "utf8"));

const commands = {
  "ffmpeg-scale": `${settings.width}:${settings.height}`,
  "screen-size": `${settings.width}x${settings.height}x${settings.xvfbColorDepth}`,
};

const command = process.argv[2];

if (!command || !(command in commands)) {
  console.error("Usage: node ./scripts/playwright-video-settings.mjs <ffmpeg-scale|screen-size>");
  process.exit(1);
}

process.stdout.write(commands[command]);
