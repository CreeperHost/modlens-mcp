import { describe, it, expect } from "vitest";
import AdmZip from "adm-zip";
import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { scanTagsFromJar } from "./mod-tags.js";

async function makeTagJar(entries: Record<string, string | null> = {}): Promise<string> {
    const zip = new AdmZip();
    for (const [name, content] of Object.entries(entries)) {
        if (content === null) {
            zip.addFile(name, Buffer.alloc(0));
        } else {
            zip.addFile(name, Buffer.from(content, "utf8"));
        }
    }
    const dest = join(tmpdir(), `test-tags-${Date.now()}.jar`);
    zip.writeZip(dest);
    return dest;
}

describe("scanTagsFromJar — null safety", () => {
    it("returns empty array for a JAR with no tag files", async () => {
        const jarPath = await makeTagJar({});
        try {
            const tags = scanTagsFromJar(jarPath);
            expect(tags).toEqual([]);
        } finally {
            await unlink(jarPath);
        }
    });

    it("does not throw when a tag-path entry has zero-byte content", async () => {
        const jarPath = await makeTagJar({
            "data/mod/tags/blocks/stone.json": "",
        });
        try {
            const tags = scanTagsFromJar(jarPath);
            expect(tags).toEqual([]);
        } finally {
            await unlink(jarPath);
        }
    });

    it("parses valid tag entries correctly", async () => {
        const content = JSON.stringify({ values: ["minecraft:stone", "minecraft:granite"], replace: false });
        const jarPath = await makeTagJar({
            "data/mymod/tags/blocks/stone_group.json": content,
        });
        try {
            const tags = scanTagsFromJar(jarPath);
            expect(tags).toHaveLength(1);
            expect(tags[0].registry).toBe("blocks");
            expect(tags[0].namespace).toBe("mymod");
            expect(tags[0].entries).toContain("minecraft:stone");
            expect(tags[0].replace).toBe(false);
        } finally {
            await unlink(jarPath);
        }
    });

    it("handles replace:true flag", async () => {
        const content = JSON.stringify({ values: ["minecraft:stone"], replace: true });
        const jarPath = await makeTagJar({
            "data/mymod/tags/items/iron_ores.json": content,
        });
        try {
            const tags = scanTagsFromJar(jarPath);
            expect(tags[0].replace).toBe(true);
        } finally {
            await unlink(jarPath);
        }
    });
});
