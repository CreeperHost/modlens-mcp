import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

const [total, hasMixins, hasAt, hasAw, classes, loaders, sample, mixinSample] = await Promise.all([
    db.mod.count(),
    db.mod.count({ where: { hasMixins: true } }),
    db.mod.count({ where: { hasAt: true } }),
    db.mod.count({ where: { hasAw: true } }),
    db.modClass.count(),
    db.mod.groupBy({ by: ["loader"], _count: { id: true } }),
    db.mod.findMany({
        take: 5,
        orderBy: { id: "asc" },
        select: { id: true, modId: true, displayName: true, loader: true, version: true, hasMixins: true, hasAt: true, hasAw: true, mixinConfigs: true },
    }),
    db.mod.findMany({
        where: { hasMixins: true },
        take: 5,
        select: { id: true, modId: true, mixinConfigs: true, mixinTargets: true },
    }),
]);

console.log("\n=== DB STATS ===");
console.log(JSON.stringify({ total, hasMixins, hasAt, hasAw, indexedClasses: classes, loaders }, null, 2));

console.log("\n=== SAMPLE MODS (first 5) ===");
console.log(JSON.stringify(sample, null, 2));

console.log("\n=== MIXIN MODS (first 5) ===");
for (const m of mixinSample) {
    console.log(`  [${m.id}] ${m.modId} — configs: ${(m.mixinConfigs as string[]).join(", ")} — targets: ${JSON.stringify(m.mixinTargets).slice(0, 120)}`);
}

await db.$disconnect();
