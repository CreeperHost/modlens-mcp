import { indexJar } from "./java-tools.js";

const jarPath = "C:/Users/Hubby/AppData/Roaming/PrismLauncher/instances/ForgeCraft - Base/minecraft/spl/servermods/Clumps-neoforge-26.1.2-26.1.2.1.jar";
try {
    console.log("Testing indexJar...");
    const raw = await indexJar(jarPath) as unknown as Record<string, unknown>;
    const classes = raw.classes as Record<string, unknown>;
    const keys = Object.keys(classes);
    console.log("class count:", keys.length);
    console.log("first key:", keys[0]);
    console.log("first value:", JSON.stringify(classes[keys[0]]));
} catch (e) {
    console.error("ERROR:", (e as Error).message);
}
