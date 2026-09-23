// Refresh reviewed standard texts from SPDX. Review and commit changes before deploying.
import { writeFile } from "node:fs/promises";
const ids = ["0BSD", "Unlicense", "MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "LGPL-3.0-only", "GPL-3.0-only", "CC-BY-NC-SA-4.0"];
const entries = await Promise.all(ids.map(async id => {
    const url = `https://raw.githubusercontent.com/spdx/license-list-data/v3.27.0/json/details/${id}.json`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${id}: ${response.status}`);
    const data = await response.json();
    return [id, { name: data.name, text: data.licenseText, source: url }];
}));
await writeFile(new URL("../src/license-templates.ts", import.meta.url),
    "// SPDX License List 3.27.0 standard texts; see scripts/update-license-templates.mjs.\n" +
    "// SPDX data: https://github.com/spdx/license-list-data (CC0-1.0).\n" +
    `export const licenseTemplates: Record<string, { name: string; text: string; source: string }> = ${JSON.stringify(Object.fromEntries(entries), null, 2)};\n`);
