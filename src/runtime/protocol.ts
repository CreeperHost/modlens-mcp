import { z } from "zod";

export const runtimeMode = z.enum(["interactive", "observe", "hidden"]);
export const runtimeCommand = z.discriminatedUnion("type", [
    z.object({ type: z.literal("mode"), mode: runtimeMode }),
    z.object({
        type: z.literal("key"),
        key: z.string().min(1).max(32),
        down: z.boolean(),
        holdMs: z.number().int().min(1).max(10_000).default(250),
    }),
    z.object({
        type: z.literal("mouse_button"),
        button: z.number().int().min(1).max(8),
        down: z.boolean(),
        holdMs: z.number().int().min(1).max(10_000).default(100),
    }),
    z.object({
        type: z.literal("mouse_move"),
        x: z.number().min(-100_000).max(100_000),
        y: z.number().min(-100_000).max(100_000),
        relative: z.boolean().default(false),
    }),
    z.object({
        type: z.literal("scroll"),
        x: z.number().min(-100).max(100).default(0),
        y: z.number().min(-100).max(100),
    }),
    z.object({ type: z.literal("text"), text: z.string().min(1).max(1024) }),
    z.object({ type: z.literal("release_all") }),
    z.object({ type: z.literal("screenshot") }),
    z.object({ type: z.literal("threads") }),
    z.object({ type: z.literal("recording") }),
    z.object({
        type: z.literal("allocations"),
        packagePrefix: z
            .string()
            .min(1)
            .max(200)
            .regex(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.?$/)
            .optional()
            .describe("Filter sampled allocation stacks to your mod package, e.g. com.example.mymod"),
        windowSeconds: z.number().int().min(5).max(120).default(30),
        limit: z.number().int().min(1).max(50).default(20),
    }),
]);
export type RuntimeCommand = z.infer<typeof runtimeCommand>;
export type RuntimeMode = z.infer<typeof runtimeMode>;
export const agentPacket = z.object({
    protocol: z.literal(1),
    sessionId: z.string().uuid(),
    pid: z.number().int().positive(),
    startedAt: z.number().positive(),
    javaVersion: z.string().max(200),
    capabilities: z.record(z.unknown()),
    state: z.record(z.unknown()),
    metrics: z.record(z.unknown()),
    events: z
        .array(
            z.object({
                seq: z.number().int().positive(),
                time: z.number(),
                type: z.string().max(80),
                data: z.record(z.unknown()),
            }),
        )
        .max(100),
    results: z.array(z.object({ id: z.string().uuid(), ok: z.boolean(), data: z.unknown() })).max(20),
});
export type AgentPacket = z.infer<typeof agentPacket>;

/** Properties uses ISO-8859-1 plus Unicode escapes, including in Java 25. */
export function properties(values: Record<string, unknown>): string {
    const escape = (s: string) =>
        [...s]
            .map((c) => {
                if (c === "\\") return "\\\\";
                if (c === "\n") return "\\n";
                if (c === "\r") return "\\r";
                if (c === "\t") return "\\t";
                if (c === " " || "=:#!".includes(c)) return "\\" + c;
                return /[^\x20-\x7e]/.test(c)
                    ? c
                          .split("")
                          .map((u) => "\\u" + u.charCodeAt(0).toString(16).padStart(4, "0"))
                          .join("")
                    : c;
            })
            .join("");
    return (
        Object.entries(values)
            .map(([k, v]) => `${escape(k)}=${escape(String(v))}`)
            .join("\n") + "\n"
    );
}
